-- Migration 007: Dead Letter Queue (persisted failed workflow executions)
-- Stores permanently failed workflow executions for admin inspection and replay.

CREATE TABLE IF NOT EXISTS dead_letter_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id VARCHAR(255) NOT NULL,
    execution_id VARCHAR(255) NOT NULL UNIQUE,
    namespace VARCHAR(255) NOT NULL DEFAULT 'default',
    status VARCHAR(50) NOT NULL,
    error_message TEXT,
    output TEXT,
    total_cost VARCHAR(50) DEFAULT '$0.000000',
    iterations INTEGER DEFAULT 0,
    tool_calls JSONB DEFAULT '[]',
    failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    replayed_at TIMESTAMPTZ,
    replay_count INTEGER DEFAULT 0,
    UNIQUE(execution_id)
);

CREATE INDEX IF NOT EXISTS idx_dlq_namespace
    ON dead_letter_queue (namespace);

CREATE INDEX IF NOT EXISTS idx_dlq_failed_at
    ON dead_letter_queue (failed_at DESC);

CREATE INDEX IF NOT EXISTS idx_dlq_agent_id
    ON dead_letter_queue (agent_id);
