import {
  type SLOStatus,
  type SLOSnapshot,
  type SLOErrorBudget,
  type SLOBurnRate,
  type SLOType,
  BURN_RATE_WINDOWS,
} from "./types.js";

export interface SLISample {
  totalRequests: number;
  failedRequests: number;
  latencyHistogram?: { bucket: number; count: number }[];
}

interface TrackedSLO {
  name: string;
  type: SLOType;
  target: number;
  history: { timestamp: number; sample: SLISample }[];
}

export class SLOTracker {
  private sloDefinition: Map<string, TrackedSLO> = new Map();
  private readonly maxHistoryPerSLO: number;

  constructor(maxHistoryPerSLO: number = 1440) {
    this.maxHistoryPerSLO = maxHistoryPerSLO;
  }

  define(name: string, type: SLOType, target: number): void {
    this.sloDefinition.set(name, { name, type, target, history: [] });
  }

  record(name: string, sample: SLISample, timestamp: number = Date.now()): void {
    const slo = this.sloDefinition.get(name);
    if (!slo) {
      throw new Error(`SLO "${name}" is not defined. Call define() first.`);
    }
    slo.history.push({ timestamp, sample });
    if (slo.history.length > this.maxHistoryPerSLO) {
      slo.history = slo.history.slice(-this.maxHistoryPerSLO);
    }
  }

  snapshot(windowMinutes: number = 30): SLOSnapshot {
    const statuses: SLOStatus[] = [];

    for (const [name, slo] of this.sloDefinition) {
      const status = this.computeStatus(name, slo, windowMinutes);
      statuses.push(status);
    }

    return {
      timestamp: new Date().toISOString(),
      windowMinutes,
      statuses,
      overallCompliant: statuses.every((s) => s.compliant),
    };
  }

  private computeStatus(
    name: string,
    slo: TrackedSLO,
    windowMinutes: number
  ): SLOStatus {
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    const windowSamples = slo.history.filter((h) => h.timestamp >= cutoff);

    const aggregated = this.aggregateSamples(windowSamples);

    const totalRequests = aggregated.totalRequests;
    const failedRequests = aggregated.failedRequests;
    const errorRate = totalRequests > 0 ? failedRequests / totalRequests : 0;

    let currentSLI: number;
    if (slo.type === "availability") {
      currentSLI = totalRequests > 0 ? 1 - errorRate : 1;
    } else {
      currentSLI = aggregated.latencyPercentileMs;
    }

    const errorBudget = this.computeErrorBudget(
      slo.type,
      slo.target,
      totalRequests,
      failedRequests,
      aggregated
    );

    const burnRates = this.computeBurnRates(
      slo.type,
      slo.target,
      windowSamples,
      windowMinutes
    );

    const compliant =
      slo.type === "availability"
        ? currentSLI >= slo.target
        : currentSLI <= slo.target;

    return {
      name,
      type: slo.type,
      target: slo.target,
      currentSLI: round(currentSLI, 6),
      errorBudget,
      burnRates,
      compliant,
    };
  }

  private aggregateSamples(
    samples: { timestamp: number; sample: SLISample }[]
  ): SLISample & { latencyPercentileMs: number } {
    let totalRequests = 0;
    let failedRequests = 0;
    const bucketMap = new Map<number, number>();

    for (const { sample } of samples) {
      totalRequests += sample.totalRequests;
      failedRequests += sample.failedRequests;
      if (sample.latencyHistogram) {
        for (const bucket of sample.latencyHistogram) {
          bucketMap.set(bucket.bucket, (bucketMap.get(bucket.bucket) ?? 0) + bucket.count);
        }
      }
    }

    const latencyPercentileMs = this.computePercentileFromBuckets(
      bucketMap,
      95,
      totalRequests
    );

    return {
      totalRequests,
      failedRequests,
      latencyHistogram: Array.from(bucketMap.entries()).map(([bucket, count]) => ({
        bucket,
        count,
      })),
      latencyPercentileMs,
    };
  }

  private computeErrorBudget(
    type: SLOType,
    target: number,
    totalRequests: number,
    actualFailures: number,
    aggregated: { latencyPercentileMs: number }
  ): SLOErrorBudget {
    if (type === "availability") {
      const allowedFailures = Math.floor((1 - target) * totalRequests);
      const remaining = Math.max(0, allowedFailures - actualFailures);
      return {
        totalRequests,
        allowedFailures,
        actualFailures,
        remainingBudget: remaining,
        remainingPercent: allowedFailures > 0
          ? round(remaining / allowedFailures, 4)
          : actualFailures === 0 ? 1 : 0,
        consumed: actualFailures >= allowedFailures,
      };
    }

    const allowedLatencyBudgetMs = target;
    const actualLatencyExcessMs = Math.max(0, aggregated.latencyPercentileMs - target);
    const remainingMs = Math.max(0, allowedLatencyBudgetMs - actualLatencyExcessMs);
    return {
      totalRequests,
      allowedFailures: 0,
      actualFailures: 0,
      remainingBudget: Math.round(remainingMs),
      remainingPercent: round(
        allowedLatencyBudgetMs > 0
          ? remainingMs / allowedLatencyBudgetMs
          : aggregated.latencyPercentileMs <= target ? 1 : 0,
        4
      ),
      consumed: aggregated.latencyPercentileMs > target,
    };
  }

  private computeBurnRates(
    type: SLOType,
    target: number,
    samples: { timestamp: number; sample: SLISample }[],
    _windowMinutes: number
  ): SLOBurnRate[] {
    const burnRates: SLOBurnRate[] = [];

    for (const windowMin of BURN_RATE_WINDOWS) {
      const cutoff = Date.now() - windowMin * 60 * 1000;
      const windowSamples = samples.filter((s) => s.timestamp >= cutoff);

      const aggregated = this.aggregateSamples(windowSamples);
      const { totalRequests, failedRequests } = aggregated;

      let rate: number;
      if (type === "availability") {
        const errorRate = totalRequests > 0 ? failedRequests / totalRequests : 0;
        const allowedErrorRate = 1 - target;
        rate = allowedErrorRate > 0 ? errorRate / allowedErrorRate : errorRate > 0 ? Infinity : 0;
      } else {
        const p95 = aggregated.latencyPercentileMs;
        rate = target > 0 ? p95 / target : p95 > 0 ? Infinity : 0;
      }

      burnRates.push({
        windowMinutes: windowMin,
        rate: round(rate, 4),
        threshold: 1,
        burning: rate > 1,
      });
    }

    return burnRates;
  }

  private computePercentileFromBuckets(
    buckets: Map<number, number>,
    percentile: number,
    totalRequests: number
  ): number {
    if (totalRequests === 0 || buckets.size === 0) return 0;

    const targetCount = Math.ceil((percentile / 100) * totalRequests);
    const sorted = Array.from(buckets.entries())
      .sort(([a], [b]) => a - b);

    let cumulative = 0;
    for (const [bucket, count] of sorted) {
      cumulative += count;
      if (cumulative >= targetCount) return bucket;
    }
    return sorted[sorted.length - 1]?.[0] ?? 0;
  }

  clear(): void {
    for (const slo of this.sloDefinition.values()) {
      slo.history = [];
    }
  }

  reset(): void {
    this.sloDefinition.clear();
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
