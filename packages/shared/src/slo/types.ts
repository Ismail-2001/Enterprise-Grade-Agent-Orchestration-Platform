export type SLOType = "availability" | "latency";

export type SLIMetricSource = "otel" | "manual" | "prometheus";

export interface SLIDefinition {
  metricName: string;
  type: SLOType;
  source: SLIMetricSource;
  description: string;
}

export interface SLOTarget {
  availability?: number;
  latency?: {
    targetMs: number;
    percentile: number;
  };
}

export interface SLOErrorBudget {
  totalRequests: number;
  allowedFailures: number;
  actualFailures: number;
  remainingBudget: number;
  remainingPercent: number;
  consumed: boolean;
}

export interface SLOBurnRate {
  windowMinutes: number;
  rate: number;
  threshold: number;
  burning: boolean;
}

export interface SLOStatus {
  name: string;
  type: SLOType;
  target: number;
  currentSLI: number;
  errorBudget: SLOErrorBudget;
  burnRates: SLOBurnRate[];
  compliant: boolean;
}

export interface SLOSnapshot {
  timestamp: string;
  windowMinutes: number;
  statuses: SLOStatus[];
  overallCompliant: boolean;
}

export const BURN_RATE_WINDOWS = [5, 30, 60] as const;

export const DEFAULT_SLO_DEFINITIONS: Record<string, SLIDefinition> = {
  "api-availability": {
    metricName: "api_availability",
    type: "availability",
    source: "otel",
    description: "HTTP API availability (non-5xx responses / total responses)",
  },
  "api-latency-p95": {
    metricName: "api_latency_p95",
    type: "latency",
    source: "otel",
    description: "API request latency at 95th percentile",
  },
  "grpc-availability": {
    metricName: "grpc_availability",
    type: "availability",
    source: "otel",
    description: "gRPC request availability (OK status / total)",
  },
  "grpc-latency-p95": {
    metricName: "grpc_latency_p95",
    type: "latency",
    source: "otel",
    description: "gRPC request latency at 95th percentile",
  },
  "agent-execution-success": {
    metricName: "agent_execution_success_rate",
    type: "availability",
    source: "otel",
    description: "Agent execution success rate",
  },
  "llm-latency-p99": {
    metricName: "llm_latency_p99",
    type: "latency",
    source: "otel",
    description: "LLM API call latency at 99th percentile",
  },
};
