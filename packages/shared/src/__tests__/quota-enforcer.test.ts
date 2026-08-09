import { createClient } from "redis";
import { QuotaEnforcer } from "../quotas/enforcer.js";
import { QuotaExceededError } from "../errors/index.js";

jest.mock("redis", () => ({
  createClient: jest.fn(),
}));

const mockCreateClient = createClient as unknown as jest.Mock;

beforeEach(() => {
  mockCreateClient.mockResolvedValue(null);
});

describe("QuotaEnforcer", () => {
  let enforcer: QuotaEnforcer;

  beforeEach(() => {
    enforcer = new QuotaEnforcer();
  });

  describe("fallback mode (no redis)", () => {
    it("allows requests under the limit", async () => {
      await expect(enforcer.check("ns-a", "agents", 1)).resolves.toBeUndefined();
    });

    it("throws QuotaExceededError for rate-based resources over the limit", async () => {
      for (let i = 0; i < 30; i++) {
        await enforcer.check("ns-a", "tool_calls_per_minute", 1);
      }
      await expect(enforcer.check("ns-a", "tool_calls_per_minute", 1)).rejects.toThrow(QuotaExceededError);
    });

    it("throws for concurrent executions over the limit", async () => {
      await enforcer.check("ns-a", "concurrent_executions", 1);
      await enforcer.check("ns-a", "concurrent_executions", 1);
      await expect(enforcer.check("ns-a", "concurrent_executions", 1)).rejects.toThrow(QuotaExceededError);
    });

    it("allows unlimited resource types not in the limits map", async () => {
      await expect(enforcer.check("ns-a", "some_unknown_resource", 1)).resolves.toBeUndefined();
    });

    it("applies the amount multiplier against the limit", async () => {
      // default agents limit 5 * amount 3 = 15, so 15 calls pass and the 16th exceeds
      for (let i = 0; i < 15; i++) {
        await enforcer.check("ns-a", "agents", 3);
      }
      await expect(enforcer.check("ns-a", "agents", 3)).rejects.toThrow(QuotaExceededError);
    });

    it("release decrements concurrent usage", async () => {
      await enforcer.check("ns-a", "concurrent_executions", 1);
      await enforcer.check("ns-a", "concurrent_executions", 1);
      await expect(enforcer.check("ns-a", "concurrent_executions", 1)).rejects.toThrow(QuotaExceededError);

      await enforcer.release("ns-a", "concurrent_executions", 1);
      await expect(enforcer.check("ns-a", "concurrent_executions", 1)).resolves.toBeUndefined();
    });

    it("reset clears fallback counters", async () => {
      await enforcer.check("ns-a", "tool_calls_per_minute", 1);
      await enforcer.reset("ns-a", "tool_calls_per_minute");
      for (let i = 0; i < 30; i++) {
        await enforcer.check("ns-a", "tool_calls_per_minute", 1);
      }
      await expect(enforcer.check("ns-a", "tool_calls_per_minute", 1)).rejects.toThrow(QuotaExceededError);
    });

    it("shutdown is a no-op without a redis client", async () => {
      await expect(enforcer.shutdown()).resolves.toBeUndefined();
    });

    it("exposes default tier limits via getLimits", async () => {
      const limits = await enforcer.getLimits("ns-a");
      expect(limits).toEqual({
        agents: 5,
        concurrent_executions: 2,
        tool_calls_per_minute: 30,
      });
    });
  });

  describe("redis mode", () => {
    it("uses redis when the client is available", async () => {
      const client = {
        get: jest.fn(async () => "1"),
        incr: jest.fn(async () => 2),
        decr: jest.fn(async () => 1),
        expire: jest.fn(async () => undefined),
        del: jest.fn(async () => 1),
        ttl: jest.fn(async () => 1),
        quit: jest.fn(async () => undefined),
      };
      const fresh = new QuotaEnforcer();
      (fresh as unknown as { redisClient: unknown }).redisClient = client;

      await fresh.check("ns-a", "agents", 1);
      expect(client.incr).toHaveBeenCalled();
      expect(client.expire).toHaveBeenCalled();

      await fresh.release("ns-a", "agents", 1);
      expect(client.decr).toHaveBeenCalled();

      await fresh.reset("ns-a", "agents");
      expect(client.del).toHaveBeenCalled();

      await fresh.shutdown();
      expect(client.quit).toHaveBeenCalled();
    });

    it("uses redis GET for concurrent execution checks", async () => {
      const client = {
        get: jest.fn(async () => "2"),
        incr: jest.fn(async () => 3),
        decr: jest.fn(async () => 1),
        expire: jest.fn(async () => undefined),
        del: jest.fn(async () => 1),
        ttl: jest.fn(async () => 1),
        quit: jest.fn(async () => undefined),
      };
      const fresh = new QuotaEnforcer();
      (fresh as unknown as { redisClient: unknown }).redisClient = client;

      await expect(fresh.check("ns-a", "concurrent_executions", 1)).rejects.toThrow(QuotaExceededError);
      expect(client.get).toHaveBeenCalled();
    });
  });
});
