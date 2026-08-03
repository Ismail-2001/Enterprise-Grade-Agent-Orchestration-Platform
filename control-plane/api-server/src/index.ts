import { initTracing, shutdownTracing, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, validateSecrets, loadSecretsIntoEnv } from "@e-gaop/shared";

initTracing("api-server");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import crypto from "crypto";
import path from "path";
import http from "http";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import pino from "pino";
import { WebSocket } from "ws";
import { Connection, Client } from "@temporalio/client";
import { getServerCredentials } from "@e-gaop/shared";
import { namespaceHandlers } from "./namespaces/handler";
import { agentHandlers } from "./agents/handler";
import { authRoutes, authenticate } from "./auth/routes";

const HEALTH_SERVICE: grpc.ServiceDefinition = {
  check: {
    path: "/grpc.health.v1.Health/Check",
    requestStream: false,
    responseStream: false,
    requestSerialize: (v: unknown) => Buffer.from(JSON.stringify(v)),
    responseSerialize: (v: unknown) => Buffer.from(JSON.stringify(v)),
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

// ─── Temporal Client ───────────────────────────────────────────────────────
let temporalClient: Client | null = null;

async function getTemporalClient(): Promise<Client> {
  if (temporalClient) return temporalClient;
  const address = process.env.TEMPORAL_ADDRESS || "temporal:7233";
  const connection = await Connection.connect({ address });
  const namespace = process.env.TEMPORAL_NAMESPACE || "egaop";
  temporalClient = new Client({ connection, namespace });
  return temporalClient;
}

const PROTO_DIR = path.resolve(__dirname, "../../../api/proto");

const agentPackageDef = protoLoader.loadSync(
  path.join(PROTO_DIR, "egaop/v1/agent.proto"),
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [PROTO_DIR] }
);

const namespacePackageDef = protoLoader.loadSync(
  path.join(PROTO_DIR, "egaop/v1/namespace.proto"),
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [PROTO_DIR] }
);

const egaopProto = grpc.loadPackageDefinition(agentPackageDef) as any;
const nsProto = grpc.loadPackageDefinition(namespacePackageDef) as any;

const agentService = egaopProto.egaop.v1.AgentService;
const namespaceService = nsProto.egaop.v1.NamespaceService;

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor()],
});

server.addService(agentService.service, {
  CreateAgent: agentHandlers.CreateAgent,
  GetAgent: agentHandlers.GetAgent,
  ListAgents: agentHandlers.ListAgents,
  UpdateAgent: agentHandlers.UpdateAgent,
  DeleteAgent: agentHandlers.DeleteAgent,
});

server.addService(namespaceService.service, {
  CreateNamespace: namespaceHandlers.CreateNamespace,
  GetNamespace: namespaceHandlers.GetNamespace,
  ListNamespaces: namespaceHandlers.ListNamespaces,
  UpdateNamespace: namespaceHandlers.UpdateNamespace,
  SuspendNamespace: namespaceHandlers.SuspendNamespace,
  DeleteNamespace: namespaceHandlers.DeleteNamespace,
});

server.addService(HEALTH_SERVICE, {
  check: (_call: any, callback: any) => {
    callback(null, { status: "SERVING" });
  }
});

// ── REST API (BFF for frontend) ──────────────────────────────────────────────

const fastify = Fastify({
  logger: false,
  bodyLimit: 1048576, // 1MB max request body
});

// Security headers on every response
fastify.addHook("onSend", async (request, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-XSS-Protection", "1; mode=block");
  reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  reply.header("Content-Security-Policy", "default-src 'self'");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  return payload;
});

const corsOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : ["http://localhost:3000", "http://localhost:5173"];

fastify.register(cors, { origin: corsOrigins, credentials: true });
fastify.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX) || 100,
  timeWindow: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  keyGenerator: (request) => {
    const userId = (request as any).userId || (request as any).user?.id;
    if (userId) return `user:${userId}`;
    const ip = request.ip ?? request.socket.remoteAddress ?? "unknown";
    return `ip:${ip}`;
  },
  addHeadersOnExceeding: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true, "x-ratelimit-reset": true },
  addHeaders: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true, "x-ratelimit-reset": true, "retry-after": true },
});
fastify.register(cookie);

fastify.register(swagger, {
  openapi: {
    openapi: "3.0.0",
    info: {
      title: "E-GAOP API",
      description: "Enterprise-Grade Agent Orchestration Platform API — manage agents, namespaces, executions, and observability across the platform.",
      version: "1.0.0",
      contact: { name: "E-GAOP Team", url: "https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents" },
      license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
    },
    servers: [
      { url: `http://localhost:${process.env.API_SERVER_REST_PORT || 3001}`, description: "Development" },
      { url: "https://api.egaop.io", description: "Production" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JWT token obtained from /api/auth/login",
        },
      },
      schemas: {
        Agent: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique agent identifier" },
            name: { type: "string", description: "Agent name" },
            version: { type: "string", example: "v1" },
            namespace: { type: "string", description: "Namespace the agent belongs to" },
            status: { type: "string", enum: ["pending", "running", "succeeded", "failed", "cancelled"] },
            health: { type: "string", enum: ["Healthy", "Unhealthy", "Unknown"] },
            createdAt: { type: "string", format: "date-time" },
            spec: { type: "object", description: "Agent specification (model, tools, prompt)" },
            owner: { type: "string" },
          },
        },
        AgentExecution: {
          type: "object",
          properties: {
            id: { type: "string" },
            agentId: { type: "string" },
            agentName: { type: "string" },
            namespace: { type: "string" },
            status: { type: "string", enum: ["running", "succeeded", "failed", "cancelled", "timeout"] },
            startTime: { type: "string", format: "date-time" },
            endTime: { type: "string", format: "date-time", nullable: true },
            durationMs: { type: "number", nullable: true },
            costUsd: { type: "number" },
          },
        },
        Namespace: {
          type: "object",
          properties: {
            name: { type: "string" },
            displayName: { type: "string" },
            agentCount: { type: "number" },
            status: { type: "string", enum: ["active", "inactive"] },
            createdAt: { type: "string", format: "date-time" },
            tier: { type: "string", enum: ["sandbox", "production", "enterprise"] },
            quotas: {
              type: "object",
              properties: {
                maxAgents: { type: "number" },
                concurrentExecutions: { type: "number" },
                toolCallsPerMinute: { type: "number" },
              },
            },
          },
        },
        Trace: {
          type: "object",
          properties: {
            traceId: { type: "string" },
            agentId: { type: "string" },
            startTime: { type: "string", format: "date-time" },
            endTime: { type: "string", format: "date-time" },
            durationMs: { type: "number" },
            spanCount: { type: "number" },
            errorCount: { type: "number" },
          },
        },
        Metrics: {
          type: "object",
          properties: {
            activeAgents: { type: "number" },
            executions24h: { type: "number" },
            avgLatencyMs: { type: "number" },
            errorRate: { type: "number" },
            totalCostUsd: { type: "number" },
            activeNamespaces: { type: "number" },
          },
        },
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                message: { type: "string" },
                code: { type: "string" },
              },
            },
          },
        },
        PaginationMeta: {
          type: "object",
          properties: {
            total: { type: "number" },
            page: { type: "number" },
            limit: { type: "number" },
            hasNext: { type: "boolean" },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Agents", description: "Agent CRUD and execution management" },
      { name: "Namespaces", description: "Namespace isolation and quotas" },
      { name: "Traces", description: "Execution traces and replay" },
      { name: "Metrics", description: "Platform metrics and monitoring" },
      { name: "Auth", description: "Authentication and registration" },
      { name: "Health", description: "Service health checks" },
      { name: "Streaming", description: "WebSocket real-time event streaming" },
    ],
  },
});

fastify.register(swaggerUi, {
  routePrefix: "/api/docs",
});

// ETag support for conditional GET (304 Not Modified)
// Stores only the content hash — never the response body — bounding memory use.
const etagStore = new Map<string, string>();

fastify.addHook("onSend", async (request, reply, payload) => {
  if (request.method === "GET" && typeof payload === "string" && reply.statusCode === 200) {
    const hash = crypto.createHash("sha256").update(payload).digest("base64url").slice(0, 27);
    const cacheKey = request.url;
    const previous = etagStore.get(cacheKey);

    if (previous === hash) {
      etagStore.delete(cacheKey);
    } else {
      etagStore.set(cacheKey, hash);
      if (etagStore.size > 500) {
        const firstKey = etagStore.keys().next().value;
        if (firstKey) etagStore.delete(firstKey);
      }
    }

    reply.header("ETag", `"${hash}"`);

    const ifNoneMatch = request.headers["if-none-match"];
    if (ifNoneMatch === `"${hash}"`) {
      reply.code(304);
      return "";
    }
  }
  return payload;
});

// Caching headers for GET responses (enables CDN/proxy caching)
const CACHE_TTL: Record<string, string> = {
  "/api/agents": "public, max-age=30, stale-while-revalidate=120",
  "/api/namespaces": "public, max-age=60, stale-while-revalidate=300",
  "/api/executions": "public, max-age=30, stale-while-revalidate=120",
  "/api/traces": "no-cache, max-age=10",
  "/api/metrics": "no-cache, max-age=15",
  "/api/events": "no-cache, max-age=10",
  "/api/auth/me": "private, no-cache, max-age=10",
};

fastify.addHook("onRequest", async (request, reply) => {
  if (request.method === "GET") {
    const cacheKey = Object.keys(CACHE_TTL).find((k) => request.url.startsWith(k));
    if (cacheKey) {
      reply.header("Cache-Control", CACHE_TTL[cacheKey]);
    }
  }
});

// Content-type enforcement for mutation requests
fastify.addHook("preHandler", async (request, reply) => {
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    const ct = request.headers["content-type"];
    if (!ct || !ct.includes("application/json")) {
      reply.code(415);
      throw new Error("Unsupported Media Type — Content-Type must be application/json");
    }
  }
});

// ── Auth routes (public) ──
fastify.register(authRoutes);

// ── Health routes (public) ──
fastify.get("/health", async () => {
  return { status: "healthy", services: [] };
});

fastify.get("/api/health", async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${process.env.API_SERVER_HEALTH_PORT || 15051}/healthz`);
    return { status: res.ok ? "ok" : "degraded", apiServerReachable: res.ok };
  } catch {
    return { status: "degraded", apiServerReachable: false };
  }
});

// ── Protected routes (require JWT) ──
fastify.addHook("preHandler", async (request, reply) => {
  // Skip auth for public routes
  const publicRoutes = ["/health", "/api/health", "/api/auth/login", "/api/auth/register"];
  if (publicRoutes.includes(request.url) || request.url.startsWith("/api/auth/")) return;
  await authenticate(request, reply);
});

const API_VERSION = "v1";

function apiResponse<T>(data: T) {
  return { data, meta: { apiVersion: API_VERSION, traceId: crypto.randomUUID(), timestamp: new Date().toISOString() } };
}

function paginate<T>(items: T[], page: number, limit: number) {
  const start = (page - 1) * limit;
  const paged = items.slice(start, start + limit);
  return { items: paged, total: items.length, page, limit, hasNext: start + limit < items.length };
}

// ── Agents REST ──

fastify.get("/api/agents", async (request) => {
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = parseInt(q.limit ?? "20", 10);

  const filters: Record<string, unknown> = {};
  if (q.namespace) filters.namespace = q.namespace;
  if (q.status) filters.phase = q.status;
  if (q.search) filters.search = q.search;

  return new Promise((resolve) => {
    agentHandlers.ListAgents(
      { request: { namespace: q.namespace ?? "", filters, pagination: { page_size: limit } } } as any,
      (_err: any, response: any) => {
        const agents = (response?.agents ?? []).map((a: any) => ({
          id: a.metadata?.uid ?? "",
          name: a.metadata?.name ?? "",
          version: `v${a.metadata?.version ?? 1}`,
          namespace: a.metadata?.namespace ?? "",
          status: a.status?.phase?.toLowerCase() ?? "pending",
          health: a.status?.health_status ?? "Healthy",
          createdAt: a.metadata?.created_at
            ? new Date(a.created_at.seconds * 1000).toISOString()
            : new Date().toISOString(),
          lastExecution: undefined,
          spec: a.spec ?? {},
          owner: a.metadata?.created_by ?? "",
        }));
        resolve(apiResponse(paginate(agents, page, limit)));
      }
    );
  });
});

fastify.get("/api/agents/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const q = request.query as Record<string, string>;
  const namespace = q.namespace ?? "default";

  return new Promise((resolve) => {
    agentHandlers.GetAgent(
      { request: { name: id, namespace } } as any,
      (err: any, response: any) => {
        if (err) {
          reply.code(404);
          resolve({ error: { message: err.message, code: "NOT_FOUND" } });
          return;
        }
        const a = response;
        resolve(apiResponse({
          id: a.metadata?.uid ?? id,
          name: a.metadata?.name ?? id,
          version: `v${a.metadata?.version ?? 1}`,
          namespace: a.metadata?.namespace ?? namespace,
          status: a.status?.phase?.toLowerCase() ?? "pending",
          health: a.status?.health_status ?? "Healthy",
          createdAt: a.metadata?.created_at ? new Date(a.metadata.created_at.seconds * 1000).toISOString() : new Date().toISOString(),
          updatedAt: a.metadata?.updated_at ? new Date(a.metadata.updated_at.seconds * 1000).toISOString() : new Date().toISOString(),
          spec: a.spec ?? {},
          labels: a.metadata?.labels ?? {},
          annotations: a.metadata?.annotations ?? {},
          owner: a.metadata?.created_by ?? "",
          apiVersion: a.api_version ?? "egaop.io/v1",
          kind: a.kind ?? "Agent",
        }));
      }
    );
  });
});

// ── Agent Executions ──

fastify.get("/api/agents/:id/executions", async (request) => {
  const { id } = request.params as { id: string };
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = parseInt(q.limit ?? "20", 10);
  const namespace = q.namespace ?? "default";

  try {
    const client = await getTemporalClient();

    // List Temporal workflows matching this agent ID
    const iterator = client.workflow.list({
      query: `WorkflowId LIKE 'agent-exec-%' AND WorkflowType = 'reactWorkflow'`,
      pageSize: limit,
    });

    const executions: Array<Record<string, unknown>> = [];

    for await (const workflow of iterator) {
      // Filter by agent ID — check if this workflow's ID contains the agent name
      if (!workflow.workflowId.includes(id)) continue;

      const startTime = workflow.startTime instanceof Date
        ? workflow.startTime.toISOString()
        : new Date().toISOString();
      const endTime = workflow.closeTime instanceof Date
        ? workflow.closeTime.toISOString()
        : undefined;
      const durationMs = workflow.closeTime instanceof Date && workflow.startTime instanceof Date
        ? workflow.closeTime.getTime() - workflow.startTime.getTime()
        : undefined;

      executions.push({
        id: workflow.workflowId,
        agentId: id,
        agentName: id,
        namespace,
        status: workflow.status.name === "Completed" ? "succeeded"
          : workflow.status.name === "Running" ? "running"
          : workflow.status.name === "Failed" ? "failed"
          : workflow.status.name === "Terminated" ? "cancelled"
          : workflow.status.name === "TimedOut" ? "timeout"
          : workflow.status.name?.toLowerCase() ?? "unknown",
        startTime,
        endTime,
        durationMs,
        costUsd: 0, // Cost tracked in observability plane
        traceId: workflow.workflowId,
        runId: (workflow as any).runtimeStatus ?? undefined,
      });
    }

    return apiResponse(paginate(executions, page, limit));
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMsg, agentId: id }, "Failed to query executions from Temporal, returning empty");
    return apiResponse(paginate([], page, limit));
  }
});

// ── Run Agent (trigger workflow) ──

fastify.post("/api/agents/:id/run", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { input?: Record<string, unknown>; namespace?: string; resourceNamespace?: string; callerRole?: string } | undefined;

  // Verify agent exists and extract configured model
  let agentFound = false;
  let agentName = id;
  let configuredModel: string | undefined;

  await new Promise<void>((resolve) => {
    agentHandlers.GetAgent(
      { request: { name: id, namespace: body?.namespace ?? "default" } } as any,
      (err: any, response: any) => {
        if (!err && response) {
          agentFound = true;
          agentName = response.metadata?.name ?? id;
          const spec = response.spec as Record<string, unknown> | undefined;
          if (spec && typeof spec.model === "string") {
            configuredModel = spec.model as string;
          }
        }
        resolve();
      }
    );
  });

  if (!agentFound) {
    reply.code(404);
    return { error: { message: `Agent not found: ${id}`, code: "NOT_FOUND" } };
  }

  // Start Temporal workflow
  const executionId = `exec-${crypto.randomUUID().slice(0, 8)}`;
  const workflowId = `agent-exec-${executionId}`;
  const namespace = body?.namespace ?? "default";

  try {
    const client = await getTemporalClient();
    const handle = await client.workflow.start("reactWorkflow", {
      args: [{
        agentId: agentName,
        executionId,
        namespace,
        resourceNamespace: body?.resourceNamespace ?? namespace,
        callerRole: "namespace_admin",
        model: configuredModel,
        systemPrompt: body?.input?.systemPrompt as string | undefined,
        initialMessages: body?.input?.prompt
          ? [{ role: "user" as const, content: body.input.prompt as string }]
          : (body?.input?.messages as Array<{ role: string; content: string }> | undefined),
      }],
      taskQueue: process.env.TEMPORAL_TASK_QUEUE || "egaop-agent-queue",
      workflowId,
      workflowExecutionTimeout: "30 minutes",
    });

    logger.info({ agentId: id, agentName, executionId, workflowId: handle.workflowId }, "Workflow started");

    return apiResponse({
      executionId,
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
      agentId: id,
      agentName,
      status: "running",
      startTime: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg, agentId: id }, "Failed to start workflow");
    reply.code(500);
    return { error: { message: "Failed to start workflow", code: "INTERNAL" } };
  }
});

fastify.get("/api/executions/:id", async (request, reply) => {
  const { id } = request.params as { id: string };

  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(id);
    const describe = await handle.describe();
    const raw = describe.raw as Record<string, unknown> | undefined;

    return apiResponse({
      workflowId: describe.workflowId,
      runId: raw?.runId ?? "",
      status: describe.status.name,
      startTime: describe.startTime?.toISOString() ?? "",
      executionTime: raw?.executionTime ?? "",
      taskQueue: describe.taskQueue,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("not found") || errMsg.includes("NotFound")) {
      reply.code(404);
      return { error: { message: `Execution not found: ${id}`, code: "NOT_FOUND" } };
    }
    reply.code(500);
    return { error: { message: "Failed to get execution", code: "INTERNAL" } };
  }
});

fastify.get("/api/executions/:id/history", async (request, reply) => {
  const { id } = request.params as { id: string };

  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(id);
    const history = await handle.fetchHistory();
    const events = history.events ?? [];

    const formattedEvents = events.map((event: any) => {
      const eventId = event.eventId != null ? String(event.eventId) : "0";
      const eventTime = event.eventTime?.seconds
        ? new Date(Number(event.eventTime.seconds) * 1000).toISOString()
        : "";
      const eventType = event.eventType ?? "UNKNOWN";

      let attributes: Record<string, unknown> = {};
      if (event.workflowExecutionStartedEventAttributes) {
        attributes = { input: event.workflowExecutionStartedEventAttributes.input };
      } else if (event.workflowTaskCompletedEventAttributes) {
        attributes = { scheduledEventId: event.workflowExecutionCompletedEventAttributes?.scheduledEventId };
      } else if (event.activityTaskCompletedEventAttributes) {
        attributes = { result: event.activityTaskCompletedEventAttributes.result };
      } else if (event.activityTaskFailedEventAttributes) {
        attributes = { error: event.activityTaskFailedEventAttributes.failure?.message };
      }

      return {
        eventId,
        eventTime,
        eventType,
        attributes,
      };
    });

    return apiResponse({
      workflowId: id,
      eventCount: formattedEvents.length,
      events: formattedEvents,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("not found") || errMsg.includes("NotFound")) {
      reply.code(404);
      return { error: { message: `Execution not found: ${id}`, code: "NOT_FOUND" } };
    }
    reply.code(500);
    return { error: { message: "Failed to get execution history", code: "INTERNAL" } };
  }
});

fastify.post("/api/agents", async (request, reply) => {
  const body = request.body as any;
  return new Promise((resolve) => {
    agentHandlers.CreateAgent(
      {
        request: {
          metadata: { name: body.name, namespace: body.namespace ?? "default" },
          spec: body.spec ?? {},
          api_version: "egaop.io/v1",
          kind: "Agent",
        },
      } as any,
      (err: any, response: any) => {
        if (err) {
          reply.code(409);
          resolve({ error: { message: err.message, code: "CONFLICT" } });
          return;
        }
        const a = response;
        resolve(apiResponse({
          id: a.metadata?.uid ?? "",
          name: a.metadata?.name ?? body.name,
          version: `v${a.metadata?.version ?? 1}`,
          namespace: a.metadata?.namespace ?? body.namespace,
          status: "pending",
          health: "Healthy",
          createdAt: a.metadata?.created_at ? new Date(a.metadata.created_at.seconds * 1000).toISOString() : new Date().toISOString(),
          spec: a.spec ?? {},
          owner: "",
        }));
      }
    );
  });
});

fastify.delete("/api/agents/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  return new Promise((resolve) => {
    agentHandlers.DeleteAgent(
      { request: { name: id, namespace: "default" } } as any,
      (err: any) => {
        if (err) { reply.code(404); resolve({ error: { message: err.message } }); return; }
        resolve(apiResponse(null));
      }
    );
  });
});

// ── Agent Version History ──

fastify.get("/api/agents/:id/versions", async (request) => {
  const { id } = request.params as { id: string };
  const q = request.query as Record<string, string>;
  const namespace = q.namespace ?? "default";
  const limit = parseInt(q.limit ?? "50", 10);

  try {
    const repo = await import("./agents/repository.js").then((m) => m.getAgentRepository());
    await repo.ensureVersionTable();
    const versions = await repo.getVersionHistory(namespace, id, limit);
    return apiResponse(versions.map((v: any) => ({
      id: v.id,
      agentId: v.agent_id,
      namespace: v.namespace,
      name: v.name,
      version: v.version,
      spec: v.spec,
      labels: v.labels,
      annotations: v.annotations,
      createdBy: v.created_by,
      createdAt: v.created_at,
      changeSummary: v.change_summary,
    })));
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMsg, agentId: id }, "Failed to get version history");
    return apiResponse([]);
  }
});

fastify.get("/api/agents/:id/versions/:version", async (request, reply) => {
  const { id, version } = request.params as { id: string; version: string };
  const q = request.query as Record<string, string>;
  const namespace = q.namespace ?? "default";
  const versionNum = parseInt(version, 10);

  if (isNaN(versionNum)) {
    reply.code(400);
    return { error: { message: "Version must be a number", code: "BAD_REQUEST" } };
  }

  try {
    const repo = await import("./agents/repository.js").then((m) => m.getAgentRepository());
    await repo.ensureVersionTable();
    const versionData = await repo.getVersion(namespace, id, versionNum);
    if (!versionData) {
      reply.code(404);
      return { error: { message: `Version ${versionNum} not found for agent ${id}`, code: "NOT_FOUND" } };
    }
    return apiResponse({
      id: versionData.id,
      agentId: versionData.agent_id,
      namespace: versionData.namespace,
      name: versionData.name,
      version: versionData.version,
      spec: versionData.spec,
      labels: versionData.labels,
      annotations: versionData.annotations,
      createdBy: versionData.created_by,
      createdAt: versionData.created_at,
      changeSummary: versionData.change_summary,
    });
  } catch (err: unknown) {
    reply.code(500);
    return { error: { message: "Failed to get version", code: "INTERNAL" } };
  }
});

// ── Agent Rollback ──

fastify.post("/api/agents/:id/rollback", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { version?: number; namespace?: string } | undefined;
  const namespace = body?.namespace ?? "default";
  const targetVersion = body?.version;

  if (!targetVersion || isNaN(targetVersion)) {
    reply.code(400);
    return { error: { message: "Target version number is required", code: "BAD_REQUEST" } };
  }

  try {
    const repo = await import("./agents/repository.js").then((m) => m.getAgentRepository());
    await repo.ensureVersionTable();
    const rolledBack = await repo.rollbackToVersion(namespace, id, targetVersion);

    if (!rolledBack) {
      reply.code(404);
      return { error: { message: `Agent or version not found`, code: "NOT_FOUND" } };
    }

    logger.info({ agentId: id, namespace, targetVersion, newVersion: rolledBack.version }, "Agent rolled back");

    return apiResponse({
      id: rolledBack.id,
      name: rolledBack.name,
      namespace: rolledBack.namespace,
      version: `v${rolledBack.version}`,
      spec: rolledBack.spec,
      rolledBackToVersion: targetVersion,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg, agentId: id }, "Rollback failed");
    reply.code(500);
    return { error: { message: "Rollback failed", code: "INTERNAL" } };
  }
});

// ── Namespaces REST ──

fastify.get("/api/namespaces", async (request) => {
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = parseInt(q.limit ?? "50", 10);

  return new Promise((resolve) => {
    namespaceHandlers.ListNamespaces(
      { request: { page_size: Math.min(Math.max(limit, 1), 100) } } as any,
      (_err: any, response: any) => {
        const ns = (response?.namespaces ?? []).map((n: any) => ({
          name: n.slug ?? "",
          displayName: n.display_name ?? n.slug ?? "",
          agentCount: 0,
          status: n.suspended_at ? "inactive" : "active",
          createdAt: n.created_at ? new Date(n.created_at.seconds * 1000).toISOString() : new Date().toISOString(),
          tier: (n.tier ?? "sandbox").replace("NAMESPACE_TIER_", "").toLowerCase(),
          quotas: {
            maxAgents: n.quotas?.max_agents ?? 10,
            concurrentExecutions: n.quotas?.max_concurrent_executions ?? 5,
            toolCallsPerMinute: n.quotas?.max_tool_calls_per_minute ?? 20,
          },
        }));
        resolve(apiResponse(paginate(ns, page, limit)));
      }
    );
  });
});

// ── Traces / Executions REST ──

fastify.get("/api/traces", async (request) => {
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = parseInt(q.limit ?? "20", 10);

  try {
    const client = await getTemporalClient();
    const listOpts: { query?: string; pageSize?: number } = {
      query: q.namespace
        ? `WorkflowType = "reactWorkflow" AND WorkflowId LIKE "agent-exec-%"`
        : `WorkflowType = "reactWorkflow"`,
      pageSize: limit,
    };

    const iterable = client.workflow.list(listOpts);
    const executions: any[] = [];
    for await (const info of iterable) {
      const statusMap: Record<string, string> = {
        RUNNING: "running",
        COMPLETED: "succeeded",
        FAILED: "failed",
        CANCELLED: "cancelled",
        TERMINATED: "terminated",
        TIMED_OUT: "timeout",
      };
      const durationMs = info.closeTime && info.startTime
        ? info.closeTime.getTime() - info.startTime.getTime()
        : undefined;

      executions.push({
        id: info.workflowId,
        agentId: info.workflowId.replace("agent-exec-", ""),
        agentName: info.type,
        namespace: q.namespace ?? "default",
        status: statusMap[info.status.name] ?? "unknown",
        startTime: info.startTime.toISOString(),
        endTime: info.closeTime?.toISOString(),
        durationMs,
        costUsd: undefined,
        traceId: "",
      });
      if (executions.length >= limit) break;
    }

    return apiResponse(paginate(executions, page, limit));
  } catch {
    return apiResponse(paginate([], page, limit));
  }
});

fastify.get("/api/traces/:traceId", async (request, reply) => {
  const { traceId } = request.params as { traceId: string };

  try {
    const client = await getTemporalClient();
    const iterable = client.workflow.list({ pageSize: 100 });

    let found: any = null;
    for await (const info of iterable) {
      if (info.workflowId === traceId || info.workflowId.endsWith(`-${traceId}`)) {
        found = info;
        break;
      }
    }

    if (!found) {
      reply.code(404);
      return { error: { message: `Trace not found: ${traceId}`, code: "NOT_FOUND" } };
    }

    const durationMs = found.closeTime && found.startTime
      ? found.closeTime.getTime() - found.startTime.getTime()
      : 0;

    return apiResponse({
      traceId: found.workflowId,
      agentId: found.workflowId.replace("agent-exec-", ""),
      executionId: found.workflowId,
      operationName: "agent.execute",
      startTime: found.startTime.toISOString(),
      endTime: found.closeTime?.toISOString() ?? found.startTime.toISOString(),
      durationMs,
      spanCount: 1,
      errorCount: found.status.name === "FAILED" ? 1 : 0,
      spans: [
        {
          spanId: "s-1",
          traceId: found.workflowId,
          operationName: "agent.execute",
          serviceName: "api-server",
          startTime: found.startTime.toISOString(),
          endTime: found.closeTime?.toISOString() ?? found.startTime.toISOString(),
          durationMs,
          status: found.status.name === "COMPLETED" ? "ok" : found.status.name === "FAILED" ? "error" : "running",
          attributes: { workflowId: found.workflowId, taskQueue: found.taskQueue },
        },
      ],
    });
  } catch (err: unknown) {
    reply.code(500);
    return { error: { message: "Failed to get trace", code: "INTERNAL" } };
  }
});

// ── Metrics REST ──

fastify.get("/api/metrics", async () => {
  try {
    const client = await getTemporalClient();
    const iterable = client.workflow.list({ query: `WorkflowType = "reactWorkflow"` });

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    let running = 0;
    let failed = 0;
    let total = 0;
    let recentCount = 0;
    let totalLatencyMs = 0;
    let totalCostUsd = 0;

    for await (const info of iterable) {
      total++;
      if (info.status.name === "RUNNING") running++;
      else if (info.status.name === "FAILED") failed++;

      if (info.startTime.getTime() > oneDayAgo) {
        recentCount++;
        if (info.closeTime) {
          totalLatencyMs += info.closeTime.getTime() - info.startTime.getTime();
        }
        // Extract cost from workflow memo if available
        const raw = (info as any).raw as Record<string, unknown> | undefined;
        const memo = raw?.memo as Record<string, unknown> | undefined;
        if (memo?.totalCost) {
          const costStr = String(memo.totalCost).replace("$", "");
          const costVal = parseFloat(costStr);
          if (!isNaN(costVal)) totalCostUsd += costVal;
        }
      }
    }

    return apiResponse({
      activeAgents: running,
      executions24h: recentCount,
      avgLatencyMs: recentCount > 0 ? Math.round(totalLatencyMs / recentCount) : 0,
      errorRate: total > 0 ? Number(((failed / total) * 100).toFixed(2)) : 0,
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      activeNamespaces: 1,
    });
  } catch {
    return apiResponse({
      activeAgents: 0,
      executions24h: 0,
      avgLatencyMs: 0,
      errorRate: 0,
      totalCostUsd: 0,
      activeNamespaces: 1,
    });
  }
});

// ── WebSocket Event Streaming ──

const executionSubscribers = new Map<string, Set<WebSocket>>();

function broadcastToExecution(executionId: string, event: string, data: Record<string, unknown>) {
  const subscribers = executionSubscribers.get(executionId);
  if (!subscribers || subscribers.size === 0) return;
  const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// SSE fallback for clients without WebSocket support
fastify.get("/api/events", async (request, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const send = (event: string, data: Record<string, unknown>) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const interval = setInterval(() => {
    send("heartbeat", { timestamp: new Date().toISOString() });
  }, 15_000);

  request.raw.on("close", () => {
    clearInterval(interval);
  });
});

// WebSocket endpoint for real-time execution streaming
// Connect to: ws://host:port/api/ws/executions/:executionId
fastify.get("/api/ws/executions/:executionId", { websocket: true } as any, async (socket: any, request: any) => {
  const { executionId } = request.params as { executionId: string };

  logger.info({ executionId }, "WebSocket client connected for execution streaming");

  // Register subscriber
  if (!executionSubscribers.has(executionId)) {
    executionSubscribers.set(executionId, new Set());
  }
  executionSubscribers.get(executionId)!.add(socket);

  // Send initial status from Temporal
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(executionId);
    const describe = await handle.describe();
    socket.send(JSON.stringify({
      event: "connected",
      data: {
        executionId,
        status: describe.status.name,
        startTime: describe.startTime?.toISOString(),
      },
      timestamp: new Date().toISOString(),
    }));

    // Poll Temporal for status updates and push to subscribers
    const pollInterval = setInterval(async () => {
      try {
        const info = await handle.describe();
        const statusMap: Record<string, string> = {
          RUNNING: "running",
          COMPLETED: "succeeded",
          FAILED: "failed",
          CANCELLED: "cancelled",
          TERMINATED: "terminated",
          TIMED_OUT: "timeout",
        };
        broadcastToExecution(executionId, "status_update", {
          executionId,
          status: statusMap[info.status.name] ?? info.status.name?.toLowerCase(),
          lastEventTimestamp: new Date().toISOString(),
        });

        // If execution is terminal, send final event and clean up
        if (["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"].includes(info.status.name)) {
          const closeTime = (info as any).closeTime;
          broadcastToExecution(executionId, "execution_finished", {
            executionId,
            status: statusMap[info.status.name],
            endTime: closeTime?.toISOString(),
          });
          clearInterval(pollInterval);
        }
      } catch {
        // Execution may have been deleted
        clearInterval(pollInterval);
      }
    }, 3000);

    // Clean up on disconnect
    socket.on("close", () => {
      logger.info({ executionId }, "WebSocket client disconnected");
      executionSubscribers.get(executionId)?.delete(socket);
      if (executionSubscribers.get(executionId)?.size === 0) {
        executionSubscribers.delete(executionId);
      }
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    socket.send(JSON.stringify({
      event: "error",
      data: { message: `Failed to subscribe: ${errMsg}` },
      timestamp: new Date().toISOString(),
    }));
    socket.close();
  }
});

// Global WebSocket endpoint for all events (broadcasts to all connected clients)
const globalSubscribers = new Set<WebSocket>();

fastify.get("/api/ws/events", { websocket: true } as any, async (socket: any) => {
  logger.info("WebSocket client connected to global event stream");
  globalSubscribers.add(socket);

  socket.send(JSON.stringify({
    event: "connected",
    data: { message: "Connected to E-GAOP event stream" },
    timestamp: new Date().toISOString(),
  }));

  socket.on("close", () => {
    globalSubscribers.delete(socket);
  });
});

// ── Start servers ──

if (process.env.NODE_ENV !== "test") {
  const GRPC_PORT = process.env.API_SERVER_GRPC_PORT || "50051";
  const REST_PORT = parseInt(process.env.API_SERVER_REST_PORT || "3001", 10);
  const HEALTH_PORT = parseInt(process.env.API_SERVER_HEALTH_PORT || "15051", 10);

  server.bindAsync(`0.0.0.0:${GRPC_PORT}`, getServerCredentials(), (err, port) => {
    if (err) {
      logger.error(err, "Failed to bind gRPC server");
      return;
    }
    server.start();
    logger.info(`E-GAOP Control Plane gRPC server listening on port ${port}`);
  });

  fastify.listen({ port: REST_PORT, host: "0.0.0.0" }, (err, address) => {
    if (err) {
      logger.error(err, "Failed to start REST server");
      process.exit(1);
    }
    logger.info(`E-GAOP Control Plane REST server listening on ${address}`);
  });

  const healthServer = http.createServer(async (req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      let temporalOk = false;
      try {
        const client = await getTemporalClient();
        await client.workflow.getHandle("health-check-test").describe();
        temporalOk = true;
      } catch (err: any) {
        // Workflow not found is OK (Temporal is reachable)
        if (err.message?.includes("not found") || err.message?.includes("NotFound")) {
          temporalOk = true;
        }
      }
      const code = temporalOk ? 200 : 503;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: temporalOk ? "SERVING" : "NOT_SERVING",
        service: "api-server",
        temporal: temporalOk ? "connected" : "unreachable",
        timestamp: new Date().toISOString(),
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down API Server...");
    await fastify.close();
    server.tryShutdown(async () => {
      healthServer.close();
      await shutdownTracing();
      logger.info("API Server shut down");
      process.exit(0);
    });
    setTimeout(() => { logger.error("Forced shutdown"); process.exit(1); }, 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { server, fastify };
