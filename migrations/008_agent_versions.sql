-- Migration 008: Agent Version History
-- Tracks every version of an agent's spec for rollback capability.

CREATE TABLE IF NOT EXISTS agent_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL,
    namespace VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    version INTEGER NOT NULL,
    spec JSONB NOT NULL DEFAULT '{}',
    labels JSONB NOT NULL DEFAULT '{}',
    annotations JSONB NOT NULL DEFAULT '{}',
    created_by VARCHAR(255) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    change_summary TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_agent_versions_ns_name
    ON agent_versions (namespace, name);

CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_id
    ON agent_versions (agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_versions_version
    ON agent_versions (namespace, name, version DESC);
