import { initTracing, shutdownTracing, validateSecrets, loadSecretsIntoEnv } from "@e-gaop/shared";

initTracing("workflow-engine");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import { Worker, NativeConnection } from '@temporalio/worker';
import http from 'http';
import path from 'path';
import pino from 'pino';
import { getPool } from '@e-gaop/shared';

const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL || "info"),
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" ? {
    transport: { target: "pino-pretty", options: { colorize: true } }
  } : {}),
});

const HEALTH_PORT = parseInt(process.env.WORKFLOW_ENGINE_HEALTH_PORT || '15058', 10);
let workerReady = false;

const healthServer = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  // ── Health / Readiness ─────────────────────────────────────────────
  if (url === '/healthz' || url === '/readyz') {
    const status = workerReady ? 'SERVING' : 'NOT_SERVING';
    const code = workerReady ? 200 : 503;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status, service: 'workflow-engine' }));
    return;
  }

  // ── DLQ Admin: list failed executions ──────────────────────────────
  if (url === '/dlq' && req.method === 'GET') {
    try {
      const pool = await getPool();
      const { rows } = await pool.query(
        `SELECT id, agent_id, execution_id, namespace, status, error_message,
                output, total_cost, iterations, failed_at, replayed_at, replay_count
         FROM dead_letter_queue
         ORDER BY failed_at DESC
         LIMIT 100`
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: rows }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  // ── DLQ Admin: replay a failed execution ──────────────────────────
  const replayMatch = url.match(/^\/dlq\/([^/]+)\/replay$/);
  if (replayMatch && req.method === 'POST') {
    try {
      const executionId = replayMatch[1];
      const pool = await getPool();
      await pool.query(
        `UPDATE dead_letter_queue
         SET replayed_at = NOW(), replay_count = replay_count + 1
         WHERE execution_id = $1`,
        [executionId]
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ replayed: true, execution_id: executionId }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

async function run() {
  const temporalAddress = `${process.env.TEMPORAL_HOST || 'temporal'}:${process.env.TEMPORAL_PORT || '7233'}`;
  logger.info(`Connecting to Temporal at ${temporalAddress}`);

  const connection = await NativeConnection.connect({
    address: temporalAddress,
  });

  // Load real temporal activities (with gRPC calls to policy-plane, sandbox-runtime, etc.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const activitiesModule = require(path.join(__dirname, 'temporal', 'activities'));
  logger.info({ activities: Object.keys(activitiesModule) }, 'Loaded temporal activities');

  const worker = await Worker.create({
    connection,
    workflowsPath: path.join(__dirname, 'temporal', 'workflows'),
    activities: activitiesModule,
    taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'egaop-agent-queue',
    namespace: process.env.TEMPORAL_NAMESPACE || 'egaop',
    maxConcurrentActivityTaskExecutions: 16,
    maxConcurrentWorkflowTaskExecutions: 8,
  });

  workerReady = true;
  logger.info('Workflow Engine worker started');

  healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    workerReady = false;
    logger.info('Shutting down Workflow Engine...');
    healthServer.close();
    await worker.shutdown();
    connection.close();
    await shutdownTracing();
    setTimeout(() => { logger.error('Forced shutdown'); process.exit(1); }, 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await worker.run();
}

run().catch((err) => {
  logger.error(err, 'Worker failed');
  process.exit(1);
});
