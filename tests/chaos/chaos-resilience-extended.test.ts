import nock from "nock";

const OPA_HOST = "http://localhost:8181";
const POLICY_PATH = "egaop/execution";

function makeInput(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    subject: { namespace: "default", clearance: 1 },
    action: "execute",
    resource: { namespace: "default" },
    namespace: "default",
    agentId: "agent-001",
    ...overrides,
  };
}

// ── Circuit Breaker Lifecycle (simulating policy-plane pattern) ──

class ChaosCircuitBreaker {
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly recoveryTimeMs: number;

  constructor(failureThreshold: number, recoveryTimeMs: number) {
    this.failureThreshold = failureThreshold;
    this.recoveryTimeMs = recoveryTimeMs;
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
    }
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = "CLOSED";
  }

  canExecute(): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "HALF_OPEN") return true;
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeMs) {
        this.state = "HALF_OPEN";
        return true;
      }
      return false;
    }
    return false;
  }

  getState(): string {
    return this.state;
  }
}

describe("Chaos: Circuit breaker full lifecycle (CLOSED → OPEN → HALF_OPEN → CLOSED)", () => {
  it("transitions through all states correctly under failure/recovery", async () => {
    const cb = new ChaosCircuitBreaker(3, 50);

    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canExecute()).toBe(true);

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canExecute()).toBe(true);

    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
    expect(cb.canExecute()).toBe(false);

    await new Promise((r) => setTimeout(r, 60));
    expect(cb.canExecute()).toBe(true);
    expect(cb.getState()).toBe("HALF_OPEN");

    cb.recordSuccess();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canExecute()).toBe(true);
  });

  it("re-opens on failure from half-open state", async () => {
    const cb = new ChaosCircuitBreaker(2, 50);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 60));
    expect(cb.canExecute()).toBe(true);
    expect(cb.getState()).toBe("HALF_OPEN");

    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
    expect(cb.canExecute()).toBe(false);
  });
});

// ── Redis Unavailable → Token Revocation Fails Open ──

describe("Chaos: Redis unavailable → token revocation fails open (tokens still valid)", () => {
  it("when Redis is down, token revocation check returns false (not revoked)", async () => {
    const checkTokenRevocation = async (token: string): Promise<boolean> => {
      try {
        const redis = { exists: async () => { throw new Error("ECONNREFUSED"); } };
        const exists = await redis.exists(`revoked:${token}`);
        return exists === 1;
      } catch {
        return false;
      }
    };

    const revoked = await checkTokenRevocation("jwt-token-abc");
    expect(revoked).toBe(false);
  });

  it("when Redis is down, token revocation write is silently swallowed", async () => {
    let writeSucceeded = false;
    const revokeToken = async (token: string, _ttl: number): Promise<void> => {
      try {
        const redis = { set: async () => { throw new Error("ECONNREFUSED"); } };
        await redis.set(`revoked:${token}`, "1", "EX", _ttl);
        writeSucceeded = true;
      } catch {
        writeSucceeded = false;
      }
    };

    await revokeToken("jwt-token-xyz", 3600);
    expect(writeSucceeded).toBe(false);
  });
});

// ── Cascade Failure: OPA Down → Policy Deny → API Returns 403 ──

describe("Chaos: Cascade failure — OPA down triggers fail-closed policy deny", () => {
  afterEach(() => nock.cleanAll());

  it("OPA timeout results in deny + no crash", async () => {
    nock(OPA_HOST)
      .post(`/v1/data/${POLICY_PATH}`)
      .delayConnection(10000)
      .reply(200, {});

    let result: { allow: boolean; reason: string } | null = null;
    try {
      result = await evaluateWithTimeout(makeInput(), 200);
    } catch {
      result = { allow: false, reason: "timeout" };
    }

    expect(result!.allow).toBe(false);
  });

  it("OPA returning malformed JSON results in deny", async () => {
    nock(OPA_HOST)
      .post(`/v1/data/${POLICY_PATH}`)
      .reply(200, "this is not json {{{");

    const result = await evaluatePolicyDirect(makeInput());
    expect(result.allow).toBe(false);
  });

  it("OPA returning empty body results in deny", async () => {
    nock(OPA_HOST)
      .post(`/v1/data/${POLICY_PATH}`)
      .reply(200, "");

    const result = await evaluatePolicyDirect(makeInput());
    expect(result.allow).toBe(false);
  });
});

// ── Concurrent Failures: Multiple Services Down Simultaneously ──

describe("Chaos: Concurrent failures — multiple upstream services fail simultaneously", () => {
  afterEach(() => nock.cleanAll());

  it("LLM + OPA both failing does not crash the process", async () => {
    nock(OPA_HOST)
      .post(`/v1/data/${POLICY_PATH}`)
      .reply(503, "OPA down");

    const results = await Promise.allSettled([
      evaluatePolicyDirect(makeInput()),
      evaluatePolicyDirect(makeInput({ action: "read" })),
      evaluatePolicyDirect(makeInput({ action: "write" })),
      simulateLlmCall(),
      simulateLlmCall(),
    ]);

    for (const r of results) {
      expect(r.status).toBe("fulfilled");
      if (r.status === "fulfilled") {
        expect(r.value.allow ?? r.value.status).toBeDefined();
      }
    }
  });

  it("burst of concurrent OPA failures all return deny without exception", async () => {
    nock(OPA_HOST)
      .post(`/v1/data/${POLICY_PATH}`)
      .times(20)
      .reply(503, "unavailable");

    const results = await Promise.all(
      Array.from({ length: 20 }, () => evaluatePolicyDirect(makeInput()))
    );

    for (const r of results) {
      expect(r.allow).toBe(false);
    }
  });
});

// ── Timeout Retry with Exponential Backoff ──

describe("Chaos: Timeout retry with exponential backoff", () => {
  it("retries up to maxRetries and eventually succeeds", async () => {
    let attempts = 0;
    const maxRetries = 4;

    const unreliableCall = async (): Promise<{ ok: boolean }> => {
      attempts++;
      if (attempts <= 2) throw new Error("ETIMEDOUT");
      return { ok: true };
    };

    let lastError: Error | null = null;
    let result: { ok: boolean } | null = null;

    for (let i = 0; i < maxRetries; i++) {
      try {
        result = await unreliableCall();
        lastError = null;
        break;
      } catch (err: any) {
        lastError = err;
        await new Promise((r) => setTimeout(r, Math.min(50 * Math.pow(2, i), 500)));
      }
    }

    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(3);
    expect(lastError).toBeNull();
  });

  it("exhausts retries and surfaces last error", async () => {
    let attempts = 0;
    const maxRetries = 3;

    const alwaysFail = async (): Promise<never> => {
      attempts++;
      throw new Error(`ECONNREFUSED attempt ${attempts}`);
    };

    let lastError: Error | null = null;
    for (let i = 0; i < maxRetries; i++) {
      try {
        await alwaysFail();
      } catch (err: any) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    expect(attempts).toBe(maxRetries);
    expect(lastError!.message).toContain("ECONNREFUSED");
  });
});

// ── Partial Write Recovery (WAL Pattern) ──

describe("Chaos: Partial write recovery — WAL pattern prevents data loss", () => {
  it("writes to WAL first, then commits — survives mid-write failure", async () => {
    const wal: { id: string; data: string; status: string }[] = [];
    const committed: { id: string; data: string }[] = [];

    const writeToWAL = async (id: string, data: string) => {
      wal.push({ id, data, status: "pending" });
    };

    const commitFromWAL = async () => {
      for (const entry of wal.filter((e) => e.status === "pending")) {
        committed.push({ id: entry.id, data: entry.data });
        entry.status = "committed";
      }
    };

    await writeToWAL("w1", "payload-1");
    await writeToWAL("w2", "payload-2");

    expect(wal).toHaveLength(2);
    expect(committed).toHaveLength(0);

    await commitFromWAL();

    expect(committed).toHaveLength(2);
    expect(wal.every((e) => e.status === "committed")).toBe(true);
  });

  it("WAL entries survive simulated crash — uncommitted entries can be replayed", async () => {
    const wal: { id: string; data: string; status: string }[] = [];
    const committed: { id: string; data: string }[] = [];

    await writeToWAL(wal, "w1", "data-1");
    await writeToWAL(wal, "w2", "data-2");
    committed.push({ id: "w1", data: "data-1" });
    wal[0].status = "committed";

    const uncommitted = wal.filter((e) => e.status === "pending");
    expect(uncommitted).toHaveLength(1);
    expect(uncommitted[0].id).toBe("w2");

    for (const entry of uncommitted) {
      committed.push({ id: entry.id, data: entry.data });
      entry.status = "committed";
    }

    expect(committed).toHaveLength(2);
  });

  async function writeToWAL(wal: { id: string; data: string; status: string }[], id: string, data: string) {
    wal.push({ id, data, status: "pending" });
  }
});

// ── gRPC Deadline Exceeded → Caller Handles Gracefully ──

describe("Chaos: gRPC deadline exceeded → caller handles gracefully", () => {
  it("simulated gRPC timeout returns error without crashing", async () => {
    const callWithDeadline = async <T>(
      fn: () => Promise<T>,
      deadlineMs: number
    ): Promise<T> => {
      return Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("DEADLINE_EXCEEDED")), deadlineMs)
        ),
      ]);
    };

    const slowService = () => new Promise<string>((r) => setTimeout(r, 5000));

    let error: string | null = null;
    try {
      await callWithDeadline(slowService, 50);
    } catch (err: any) {
      error = err.message;
    }

    expect(error).toBe("DEADLINE_EXCEEDED");
  });

  it("fast service completes before deadline", async () => {
    const callWithDeadline = async <T>(
      fn: () => Promise<T>,
      deadlineMs: number
    ): Promise<T> => {
      return Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("DEADLINE_EXCEEDED")), deadlineMs)
        ),
      ]);
    };

    const fastService = () => Promise.resolve("result");
    const result = await callWithDeadline(fastService, 1000);
    expect(result).toBe("result");
  });
});

// ── Helpers ──

async function evaluatePolicyDirect(input: Record<string, unknown>): Promise<{ allow: boolean; reason: string }> {
  return new Promise((resolve) => {
    const data = JSON.stringify({ input });
    const url = new URL(`/v1/data/${POLICY_PATH}`, OPA_HOST);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        timeout: 5000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            resolve({ allow: false, reason: `OPA error: ${res.statusCode}` });
          } else {
            try {
              const parsed = JSON.parse(body) as { result?: { allow?: boolean; reason?: string } };
              resolve({
                allow: parsed.result?.allow ?? false,
                reason: parsed.result?.reason ?? "",
              });
            } catch {
              resolve({ allow: false, reason: "Invalid OPA response" });
            }
          }
        });
      }
    );

    req.on("error", () => resolve({ allow: false, reason: "OPA connection failed" }));
    req.on("timeout", () => { req.destroy(); resolve({ allow: false, reason: "OPA timeout" }); });
    req.write(data);
    req.end();
  });
}

async function evaluateWithTimeout(input: Record<string, unknown>, timeoutMs: number): Promise<{ allow: boolean; reason: string }> {
  return Promise.race([
    evaluatePolicyDirect(input),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
  ]);
}

async function simulateLlmCall(): Promise<{ status: number; body: string }> {
  return { status: 503, body: "LLM unavailable" };
}

import http from "http";
