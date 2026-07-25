import { createAuditEntry, getAuditChain, verifyAuditChain } from "../audit/index.js";

beforeEach(() => {
  process.env.AUDIT_CHAIN_ID = "test-chain";
});

afterEach(() => {
  delete process.env.AUDIT_CHAIN_ID;
});

describe("Audit Module", () => {
  it("should create a signed audit entry", () => {
    const entry = createAuditEntry(
      "sandbox.create",
      "info",
      { type: "service", id: "sandbox-runtime" },
      { name: "CreateSandbox", result: "allowed" },
      { type: "sandbox", id: "sandbox-1" },
    );

    expect(entry.version).toBe("egaop-audit/1.0");
    expect(entry.eventType).toBe("sandbox.create");
    expect(entry.severity).toBe("info");
    expect(entry.actor.id).toBe("sandbox-runtime");
    expect(entry.target?.id).toBe("sandbox-1");
    expect(entry.action.name).toBe("CreateSandbox");
    expect(entry.action.result).toBe("allowed");
    expect(entry.integrity.previousHash).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.integrity.chainId).toBe("test-chain");
    expect(entry.eventId).toBeTruthy();
    expect(entry.timestamp).toBeTruthy();
  });

  it("should chain entries via previousHash", () => {
    const entry1 = createAuditEntry(
      "auth.login",
      "info",
      { type: "user", id: "user-1" },
      { name: "Login", result: "allowed" },
    );
    const entry2 = createAuditEntry(
      "policy.decision",
      "info",
      { type: "service", id: "opa" },
      { name: "AllowAction", result: "allowed" },
    );

    // entry2's previousHash should be the hash of entry1's data
    expect(entry2.integrity.previousHash).not.toBe(entry1.integrity.previousHash);
    expect(entry2.integrity.previousHash).not.toBe(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("should store entries and retrieve chain", () => {
    createAuditEntry(
      "sandbox.create",
      "info",
      { type: "service", id: "test" },
      { name: "Create", result: "allowed" },
    );

    const chain = getAuditChain("test-chain");
    expect(chain.length).toBeGreaterThanOrEqual(1);
    expect(chain[chain.length - 1]?.eventType).toBe("sandbox.create");
  });

  it("should verify a valid chain", () => {
    // Use a unique chain ID to get a clean chain
    const chainId = "verify-test-chain";
    process.env.AUDIT_CHAIN_ID = chainId;

    const e1 = createAuditEntry(
      "auth.login",
      "info",
      { type: "user", id: "alice" },
      { name: "Login", result: "allowed" },
    );
    const e2 = createAuditEntry(
      "secret.access",
      "warn",
      { type: "service", id: "vault" },
      { name: "ReadSecret", result: "allowed" },
      { type: "secret", id: "enc-key" },
    );

    const chain = getAuditChain(chainId);
    expect(verifyAuditChain(chain)).toBe(true);

    process.env.AUDIT_CHAIN_ID = "test-chain";
  });

  it("should detect chain tampering", () => {
    const chainId = "tamper-test-chain";
    process.env.AUDIT_CHAIN_ID = chainId;

    const e1 = createAuditEntry(
      "auth.login",
      "info",
      { type: "user", id: "bob" },
      { name: "Login", result: "allowed" },
    );
    const e2 = createAuditEntry(
      "config.change",
      "warn",
      { type: "user", id: "admin" },
      { name: "UpdateConfig", result: "allowed" },
    );

    const chain = getAuditChain(chainId);
    chain[0]!.action.result = "denied";

    expect(verifyAuditChain(chain)).toBe(false);
    process.env.AUDIT_CHAIN_ID = "test-chain";
  });

  it("should handle all event types", () => {
    const eventTypes = [
      "auth.login", "auth.logout", "auth.token_refresh", "auth.failed_login",
      "policy.decision", "policy.deny",
      "secret.access", "secret.create", "secret.update", "secret.delete",
      "sandbox.create", "sandbox.destroy", "sandbox.exec",
      "namespace.create", "namespace.update", "namespace.suspend", "namespace.delete",
      "agent.create", "agent.execution_start", "agent.execution_end", "agent.tool_call",
      "config.change", "certificate.rotate", "key.rotate",
    ] as const;

    for (const eventType of eventTypes) {
      const entry = createAuditEntry(
        eventType,
        "info",
        { type: "system", id: "test" },
        { name: "Test", result: "allowed" },
      );
      expect(entry.eventType).toBe(eventType);
    }

    const chain = getAuditChain("test-chain");
    expect(chain.length).toBeGreaterThanOrEqual(eventTypes.length);
  });
});
