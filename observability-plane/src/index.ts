import { initTracing, shutdownTracing, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, createTraceServerInterceptor, validateSecrets, loadSecretsIntoEnv } from "@e-gaop/shared";

initTracing("observability-plane");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import path from "path";
import http from "http";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import pino from "pino";
import { Pool } from "pg";
import { getServerCredentials } from "@e-gaop/shared";
import { ObservabilityRepository } from "./repository";

const HEALTH_SERVICE: grpc.ServiceDefinition = {
  check: {
    path: "/grpc.health.v1.Health/Check",
    requestStream: false,
    responseStream: false,
    requestSerialize: (v: any) => Buffer.from(JSON.stringify(v)),
    responseSerialize: (v: any) => Buffer.from(JSON.stringify(v)),
    requestDeserialize: (b: Buffer) => JSON.parse(b.toString()),
    responseDeserialize: (b: Buffer) => JSON.parse(b.toString()),
  },
};

const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL || "info"),
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" ? {
    transport: { target: "pino-pretty", options: { colorize: true } }
  } : {}),
});

// ─── PostgreSQL connection ────────────────────────────────────────────────

const pgPool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
  database: process.env.POSTGRES_DB || "egaop",
  user: process.env.POSTGRES_USER || "egaop",
  password: process.env.POSTGRES_PASSWORD || "",
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const obsRepo = new ObservabilityRepository(pgPool);

pgPool.on("error", (err) => logger.warn({ err: err.message }, "PostgreSQL connection issue"));

// ─── Proto setup ──────────────────────────────────────────────────────────

const PROTO_PATH = path.resolve(__dirname, "../../api/proto/egaop/v1/execution.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../api/proto")]
});

const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;
const obsService = egaopProto.egaop.v1.ObservabilityService;

// In-memory cache for hot traces (recent spans quick access)
const traceStore: Map<string, any[]> = new Map();

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor(), createTraceServerInterceptor()],
});

server.addService(obsService.service, {
  ExportTrace: async (call: any, callback: any) => {
    const { execution_id, span_id, name, start_time, end_time, attributes } = call.request;

    logger.info({ execution_id, span_id, name }, "Ingesting observability span...");

    // Hot path: keep in memory for fast replay
    const existing = traceStore.get(execution_id) || [];
    existing.push({ span_id, name, start_time, end_time, attributes });
    traceStore.set(execution_id, existing);

    // Durable path: persist to PostgreSQL
    try {
      const span = {
        traceId: execution_id,
        spanId: span_id || `span-${Date.now()}`,
        parentSpanId: null,
        serviceName: "egaop",
        operationName: name || "unknown",
        namespace: attributes?.fields?.['egaop.namespace']?.stringValue || "default",
        startTime: start_time?.seconds ? new Date(start_time.seconds * 1000) : new Date(),
        endTime: end_time?.seconds ? new Date(end_time.seconds * 1000) : null,
        status: attributes?.fields?.['egaop.status']?.stringValue || "ok",
        attributes: attributes || {},
        events: [],
      };
      await obsRepo.ingestSpan(span);
    } catch (pgErr: any) {
      logger.warn({ err: pgErr.message, execution_id }, "PostgreSQL span ingestion failed");
    }

    const cost = attributes?.fields?.['egaop.llm.cost']?.stringValue || "$0.00";
    if (cost !== "$0.00") {
       logger.info({ execution_id, cost }, "Accumulating execution cost...");
    }

    callback(null, { success: true });
  },

  GetExecutionReplay: async (call: any, callback: any) => {
    const { execution_id } = call.request;

    logger.info({ execution_id }, "Constructing Execution Replay bundle...");

    // Try PostgreSQL first (durable), fall back to in-memory
    let spans: any[] = [];

    try {
      const pgSpans = await obsRepo.getTrace(execution_id, "default");
      if (pgSpans.length > 0) {
        spans = pgSpans.map((s) => ({
          span_id: s.spanId,
          name: s.operationName,
          start_time: { seconds: Math.floor(s.startTime.getTime() / 1000) },
          end_time: s.endTime ? { seconds: Math.floor(s.endTime.getTime() / 1000) } : null,
          attributes: s.attributes,
        }));
      }
    } catch (pgErr: any) {
      logger.warn({ err: pgErr.message, execution_id }, "PostgreSQL replay query failed, falling back to memory");
    }

    // Fall back to in-memory store
    if (spans.length === 0) {
      spans = traceStore.get(execution_id) || [];
    }

    if (spans.length === 0) {
       return callback({
          code: grpc.status.NOT_FOUND,
          message: `Execution ${execution_id} not found.`
       });
    }

    // Calculate real total cost from span attributes
    let totalCost = 0;
    let totalDurationMs = 0;
    const steps = spans.map((s: any, idx: number) => {
      const costStr = s.attributes?.fields?.['egaop.llm.cost']?.stringValue || "$0.00";
      const costVal = parseFloat(costStr.replace("$", "")) || 0;
      totalCost += costVal;

      const startSec = s.start_time?.seconds || 0;
      const endSec = s.end_time?.seconds || startSec;
      const durationMs = (endSec - startSec) * 1000;
      totalDurationMs += durationMs;

      return {
        step: idx + 1,
        type: s.name,
        name: s.name,
        input: {},
        output: s.attributes,
        cost: costStr,
        duration_ms: durationMs,
        status: "succeeded",
        policy_decision: "allow"
      };
    });

    // Query real agent info from the first span's attributes
    const agentRef = spans[0]?.attributes?.fields?.['egaop.agent_id']?.stringValue || "unknown";

    const record = {
       execution_id,
       agent_ref: agentRef,
       inputs: {},
       steps,
       outputs: { status: "fulfilled" },
       total_cost: `$${totalCost.toFixed(6)}`,
       total_duration_ms: totalDurationMs,
       policy_violations: 0
    };

    logger.info({ execution_id, total_cost: record.total_cost, steps: steps.length }, "Replay bundle constructed.");
    callback(null, record);
  }
});

server.addService(HEALTH_SERVICE, {
  check: async (_call: any, callback: any) => {
    try {
      await pgPool.query("SELECT 1");
      callback(null, { status: "SERVING" });
    } catch {
      callback(null, { status: "NOT_SERVING" });
    }
  }
});

if (process.env.NODE_ENV !== "test") {
  const OBS_PORT = process.env.OBSERVABILITY_PLANE_PORT || "50056";
  const HEALTH_PORT = parseInt(process.env.OBSERVABILITY_PLANE_HEALTH_PORT || "15056", 10);

  server.bindAsync(`0.0.0.0:${OBS_PORT}`, getServerCredentials(), (err, port) => {
    if (err) {
      logger.error(err, "Failed to bind Observability Plane server");
      return;
    }
    server.start();
    logger.info(`E-GAOP Observability Plane listening on port ${port}`);
  });

  const healthServer = http.createServer(async (req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      try {
        await pgPool.query("SELECT 1");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "SERVING", service: "observability-plane", timestamp: new Date().toISOString() }));
      } catch {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "NOT_SERVING", service: "observability-plane" }));
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down Observability Plane...");
    server.tryShutdown(async () => {
      healthServer.close();
      await pgPool.end();
      await shutdownTracing();
      logger.info("Observability Plane shut down");
      process.exit(0);
    });
    setTimeout(() => { logger.error("Forced shutdown"); process.exit(1); }, 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { server, traceStore, pgPool, obsRepo };
