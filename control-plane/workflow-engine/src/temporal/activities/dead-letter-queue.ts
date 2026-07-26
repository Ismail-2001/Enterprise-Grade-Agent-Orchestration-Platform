import { getPool } from "@e-gaop/shared";
import type { AgentResult } from "../types";

export interface ReportOutcomeParams {
  agentId: string;
  executionId: string;
  namespace: string;
  result: AgentResult;
}

export async function reportOutcome(params: ReportOutcomeParams): Promise<void> {
  if (params.result.status !== "ERROR") {
    return;
  }

  try {
    const pool = await getPool();
    await pool.query(
      `INSERT INTO dead_letter_queue
        (agent_id, execution_id, namespace, status, error_message, output, total_cost, iterations, tool_calls)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (execution_id)
       DO UPDATE SET
         status = EXCLUDED.status,
         error_message = EXCLUDED.error_message,
         output = EXCLUDED.output,
         tool_calls = EXCLUDED.tool_calls,
         replay_count = dead_letter_queue.replay_count`,
      [
        params.agentId,
        params.executionId,
        params.namespace,
        params.result.status,
        params.result.error ?? null,
        params.result.output,
        params.result.totalCost,
        params.result.iterations,
        JSON.stringify(params.result.toolCalls),
      ]
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[DLQ] Failed to record outcome for ${params.executionId}: ${msg}`);
  }
}
