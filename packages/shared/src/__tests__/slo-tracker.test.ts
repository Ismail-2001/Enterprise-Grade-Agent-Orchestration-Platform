import { SLOTracker, SLISample } from "../slo/index";
import { BURN_RATE_WINDOWS, DEFAULT_SLO_DEFINITIONS } from "../slo/types";

describe("SLOTracker", () => {
  let tracker: SLOTracker;

  beforeEach(() => {
    tracker = new SLOTracker(100);
  });

  describe("define / record", () => {
    it("should define an SLO and record a sample", () => {
      tracker.define("test-slo", "availability", 0.999);
      tracker.record("test-slo", { totalRequests: 1000, failedRequests: 1 });
      const snap = tracker.snapshot(30);
      expect(snap.statuses).toHaveLength(1);
      expect(snap.statuses[0].name).toBe("test-slo");
    });

    it("should throw on recording to an undefined SLO", () => {
      expect(() =>
        tracker.record("nonexistent", { totalRequests: 100, failedRequests: 0 })
      ).toThrow('SLO "nonexistent" is not defined');
    });

    it("should trim history when exceeding maxHistoryPerSLO", () => {
      const smallTracker = new SLOTracker(3);
      const now = Date.now();
      smallTracker.define("a", "availability", 0.99);
      smallTracker.record("a", { totalRequests: 100, failedRequests: 0 }, now - 4000);
      smallTracker.record("a", { totalRequests: 100, failedRequests: 1 }, now - 3000);
      smallTracker.record("a", { totalRequests: 100, failedRequests: 2 }, now - 2000);
      smallTracker.record("a", { totalRequests: 100, failedRequests: 5 }, now - 1000);
      const snap = smallTracker.snapshot(30);
      expect(snap.statuses[0].errorBudget.actualFailures).toBe(8);
    });
  });

  describe("availability SLO", () => {
    it("should compute SLI = 1 when no failures", () => {
      tracker.define("avail", "availability", 0.999);
      tracker.record("avail", { totalRequests: 10000, failedRequests: 0 }, Date.now());
      const snap = tracker.snapshot(30);
      expect(snap.statuses[0].currentSLI).toBe(1);
      expect(snap.statuses[0].compliant).toBe(true);
    });

    it("should compute SLI = 0.999 when 10 failures in 10000", () => {
      tracker.define("avail", "availability", 0.999);
      tracker.record("avail", { totalRequests: 10000, failedRequests: 10 }, Date.now());
      const snap = tracker.snapshot(30);
      expect(snap.statuses[0].currentSLI).toBe(0.999);
      expect(snap.statuses[0].compliant).toBe(true);
    });

    it("should be non-compliant when error rate exceeds budget", () => {
      tracker.define("avail", "availability", 0.999);
      tracker.record("avail", { totalRequests: 1000, failedRequests: 2 }, Date.now());
      const snap = tracker.snapshot(30);
      expect(snap.statuses[0].currentSLI).toBe(0.998);
      expect(snap.statuses[0].compliant).toBe(false);
    });

    it("should compute correct error budget", () => {
      tracker.define("avail", "availability", 0.999);
      tracker.record("avail", { totalRequests: 10000, failedRequests: 5 }, Date.now());
      const snap = tracker.snapshot(30);
      const budget = snap.statuses[0].errorBudget;
      expect(budget.totalRequests).toBe(10000);
      expect(budget.allowedFailures).toBe(10);
      expect(budget.actualFailures).toBe(5);
      expect(budget.remainingBudget).toBe(5);
      expect(budget.consumed).toBe(false);
    });

    it("should mark consumed when budget exceeded", () => {
      tracker.define("avail", "availability", 0.999);
      tracker.record("avail", { totalRequests: 10000, failedRequests: 15 }, Date.now());
      const snap = tracker.snapshot(30);
      expect(snap.statuses[0].errorBudget.consumed).toBe(true);
      expect(snap.statuses[0].errorBudget.remainingBudget).toBe(0);
    });

    it("should return SLI = 1 for zero total requests", () => {
      tracker.define("avail", "availability", 0.999);
      tracker.record("avail", { totalRequests: 0, failedRequests: 0 }, Date.now());
      const snap = tracker.snapshot(30);
      expect(snap.statuses[0].currentSLI).toBe(1);
      expect(snap.statuses[0].compliant).toBe(true);
    });
  });

  describe("latency SLO", () => {
    it("should compute p95 from histogram buckets", () => {
      tracker.define("lat", "latency", 1000);
      const buckets = [
        { bucket: 100, count: 50 },
        { bucket: 250, count: 30 },
        { bucket: 500, count: 15 },
        { bucket: 1000, count: 4 },
        { bucket: 2000, count: 1 },
      ];
      tracker.record("lat", { totalRequests: 100, failedRequests: 0, latencyHistogram: buckets }, Date.now());
      const snap = tracker.snapshot(30);
      expect(snap.statuses[0].currentSLI).toBeGreaterThan(0);
      expect(snap.statuses[0].compliant).toBe(true);
    });

    it("should be non-compliant when p95 exceeds target", () => {
      tracker.define("lat", "latency", 500);
      const buckets = [
        { bucket: 100, count: 10 },
        { bucket: 250, count: 10 },
        { bucket: 500, count: 10 },
        { bucket: 1000, count: 10 },
        { bucket: 2000, count: 60 },
      ];
      tracker.record("lat", { totalRequests: 100, failedRequests: 0, latencyHistogram: buckets }, Date.now());
      const snap = tracker.snapshot(30);
      expect(snap.statuses[0].compliant).toBe(false);
    });

    it("should return 0 p95 for empty histogram", () => {
      tracker.define("lat", "latency", 1000);
      tracker.record("lat", { totalRequests: 0, failedRequests: 0 }, Date.now());
      const snap = tracker.snapshot(30);
      expect(snap.statuses[0].currentSLI).toBe(0);
    });
  });

  describe("burn rates", () => {
    it("should compute burn rates for all windows", () => {
      tracker.define("avail", "availability", 0.999);
      const now = Date.now();
      for (let i = 0; i < 60; i++) {
        tracker.record("avail", { totalRequests: 100, failedRequests: 2 }, now - i * 60000);
      }
      const snap = tracker.snapshot(60);
      expect(snap.statuses[0].burnRates).toHaveLength(BURN_RATE_WINDOWS.length);
      for (const br of snap.statuses[0].burnRates) {
        expect(typeof br.rate).toBe("number");
        expect(typeof br.burning).toBe("boolean");
        expect([5, 30, 60]).toContain(br.windowMinutes);
      }
    });

    it("should report burning = true when error rate exceeds budget rate", () => {
      tracker.define("avail", "availability", 0.999);
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        tracker.record("avail", { totalRequests: 100, failedRequests: 5 }, now - i * 60000);
      }
      const snap = tracker.snapshot(30);
      const allBurning = snap.statuses[0].burnRates.every((br) => br.burning);
      expect(allBurning).toBe(true);
    });

    it("should report burning = false for perfect traffic", () => {
      tracker.define("avail", "availability", 0.999);
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        tracker.record("avail", { totalRequests: 100, failedRequests: 0 }, now - i * 60000);
      }
      const snap = tracker.snapshot(30);
      const noneBurning = snap.statuses[0].burnRates.every((br) => !br.burning);
      expect(noneBurning).toBe(true);
    });
  });

  describe("window filtering", () => {
    it("should only include samples within the window", () => {
      tracker.define("avail", "availability", 0.999);
      const now = Date.now();
      tracker.record("avail", { totalRequests: 1000, failedRequests: 0 }, now - 120000);
      tracker.record("avail", { totalRequests: 1000, failedRequests: 0 }, now - 30000);
      const snap = tracker.snapshot(1);
      expect(snap.statuses[0].errorBudget.totalRequests).toBe(1000);
    });

    it("should default to 30-minute window", () => {
      tracker.define("avail", "availability", 0.999);
      const now = Date.now();
      tracker.record("avail", { totalRequests: 100, failedRequests: 0 }, now - 60000);
      const snap = tracker.snapshot();
      expect(snap.windowMinutes).toBe(30);
    });
  });

  describe("snapshot", () => {
    it("should report overallCompliant = true when all SLOs pass", () => {
      tracker.define("a", "availability", 0.999);
      tracker.define("b", "latency", 2000);
      tracker.record("a", { totalRequests: 10000, failedRequests: 0 }, Date.now());
      tracker.record("b", { totalRequests: 100, failedRequests: 0, latencyHistogram: [{ bucket: 100, count: 100 }] }, Date.now());
      const snap = tracker.snapshot(30);
      expect(snap.overallCompliant).toBe(true);
    });

    it("should report overallCompliant = false when any SLO fails", () => {
      tracker.define("a", "availability", 0.999);
      tracker.define("b", "latency", 2000);
      tracker.record("a", { totalRequests: 100, failedRequests: 5 }, Date.now());
      tracker.record("b", { totalRequests: 100, failedRequests: 0, latencyHistogram: [{ bucket: 100, count: 100 }] }, Date.now());
      const snap = tracker.snapshot(30);
      expect(snap.overallCompliant).toBe(false);
    });

    it("should include timestamp and windowMinutes", () => {
      tracker.define("x", "availability", 0.999);
      tracker.record("x", { totalRequests: 1, failedRequests: 0 }, Date.now());
      const snap = tracker.snapshot(60);
      expect(snap.timestamp).toBeDefined();
      expect(snap.windowMinutes).toBe(60);
    });
  });

  describe("clear / reset", () => {
    it("clear() removes all history but keeps definitions", () => {
      tracker.define("a", "availability", 0.999);
      tracker.record("a", { totalRequests: 100, failedRequests: 0 }, Date.now());
      tracker.clear();
      const snap = tracker.snapshot(30);
      expect(snap.statuses[0].errorBudget.totalRequests).toBe(0);
    });

    it("reset() removes all definitions", () => {
      tracker.define("a", "availability", 0.999);
      tracker.reset();
      const snap = tracker.snapshot(30);
      expect(snap.statuses).toHaveLength(0);
    });
  });

  describe("DEFAULT_SLO_DEFINITIONS", () => {
    it("should contain 6 default SLO definitions", () => {
      expect(Object.keys(DEFAULT_SLO_DEFINITIONS)).toHaveLength(6);
    });

    it("each definition should have required fields", () => {
      for (const [name, def] of Object.entries(DEFAULT_SLO_DEFINITIONS)) {
        expect(def.metricName).toBeDefined();
        expect(["availability", "latency"]).toContain(def.type);
        expect(["otel", "manual", "prometheus"]).toContain(def.source);
        expect(def.description).toBeDefined();
      }
    });
  });
});
