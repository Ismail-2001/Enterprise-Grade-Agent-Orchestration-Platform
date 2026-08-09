import { TokenBudget, extractNamespace } from "../budget/index.js";

describe("extractNamespace", () => {
  it("extracts the namespace from an agent id", () => {
    expect(extractNamespace("ns-a/agent-1")).toBe("ns-a");
  });

  it("defaults to 'default' when no slash is present", () => {
    expect(extractNamespace("agent-without-ns")).toBe("default");
  });
});

describe("TokenBudget", () => {
  let budget: TokenBudget;

  beforeEach(() => {
    budget = new TokenBudget({
      maxTokensPerDay: 1_000_000,
      maxCostPerDay: 500_000,
      maxRequestsPerMinute: 1_000,
    });
  });

  it("allows consumption within all limits", () => {
    const result = budget.tryConsume("ns-a", 100, 10);
    expect(result).toEqual({ allowed: true });
    expect(budget.getUsage("ns-a")).toEqual({
      tokensUsed: 100,
      costUsed: 10,
      requestCount: 1,
    });
  });

  it("rejects when requests per minute are exceeded", () => {
    const tight = new TokenBudget({
      maxRequestsPerMinute: 2,
      maxTokensPerDay: 1_000_000,
      maxCostPerDay: 500_000,
    });
    tight.tryConsume("ns-a", 1, 1);
    tight.tryConsume("ns-a", 1, 1);
    const result = tight.tryConsume("ns-a", 1, 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("RPM_EXCEEDED");
  });

  it("rejects when daily token budget is exceeded", () => {
    const tight = new TokenBudget({
      maxTokensPerDay: 100,
      maxCostPerDay: 500_000,
      maxRequestsPerMinute: 1_000,
    });
    expect(tight.tryConsume("ns-a", 60, 1).allowed).toBe(true);
    const result = tight.tryConsume("ns-a", 50, 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("DAILY_TOKEN_BUDGET_EXCEEDED");
  });

  it("rejects when daily cost budget is exceeded", () => {
    const tight = new TokenBudget({
      maxCostPerDay: 100,
      maxTokensPerDay: 1_000_000,
      maxRequestsPerMinute: 1_000,
    });
    expect(tight.tryConsume("ns-a", 1, 60).allowed).toBe(true);
    const result = tight.tryConsume("ns-a", 1, 50);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("DAILY_COST_BUDGET_EXCEEDED");
  });

  it("respects per-namespace allocations", () => {
    budget.setAllocation("premium", { maxTokensPerDay: 1_000 });
    expect(budget.tryConsume("premium", 600, 100).allowed).toBe(true);
    expect(budget.tryConsume("premium", 500, 100).allowed).toBe(false);
  });

  it("isExhausted reflects token or cost usage", () => {
    const tight = new TokenBudget({
      maxTokensPerDay: 100,
      maxCostPerDay: 100,
      maxRequestsPerMinute: 1_000,
    });
    expect(tight.isExhausted("ns-a")).toBe(false);
    tight.tryConsume("ns-a", 100, 0);
    expect(tight.isExhausted("ns-a")).toBe(true);
  });

  it("getAllocations returns a snapshot", () => {
    budget.setAllocation("ns-a", { maxRequestsPerMinute: 5 });
    const allocations = budget.getAllocations();
    expect(allocations.get("ns-a")).toMatchObject({ maxRequestsPerMinute: 5 });
  });

  it("reset clears a namespace's state", () => {
    budget.tryConsume("ns-a", 10, 1);
    budget.reset("ns-a");
    expect(budget.getUsage("ns-a")).toEqual({ tokensUsed: 0, costUsed: 0, requestCount: 0 });
  });

  it("resetAll clears all states", () => {
    budget.tryConsume("ns-a", 10, 1);
    budget.tryConsume("ns-b", 10, 1);
    budget.resetAll();
    expect(budget.getUsage("ns-a").tokensUsed).toBe(0);
    expect(budget.getUsage("ns-b").tokensUsed).toBe(0);
  });

  it("resets the minute window after MAX window elapses", () => {
    jest.useFakeTimers();
    try {
      const tight = new TokenBudget({
        maxRequestsPerMinute: 1,
        maxTokensPerDay: 1_000_000,
        maxCostPerDay: 500_000,
      });
      expect(tight.tryConsume("ns-a", 1, 1).allowed).toBe(true);
      expect(tight.tryConsume("ns-a", 1, 1).allowed).toBe(false);

      jest.advanceTimersByTime(60_001);
      expect(tight.tryConsume("ns-a", 1, 1).allowed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
