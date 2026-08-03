import { Pool } from "pg";
import crypto from "crypto";

export interface AgentRow {
  id: string;
  namespace: string;
  name: string;
  api_version: string;
  kind: string;
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AgentVersionRow {
  id: string;
  agent_id: string;
  namespace: string;
  name: string;
  version: number;
  spec: Record<string, unknown>;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  created_by: string;
  created_at: string;
  change_summary: string;
}

interface AgentRepositoryConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export class AgentRepository {
  private pool: Pool;

  constructor(config?: AgentRepositoryConfig) {
    this.pool = new Pool({
      host: config?.host ?? process.env.POSTGRES_HOST ?? "postgres",
      port: config?.port ?? parseInt(process.env.POSTGRES_PORT ?? "5432", 10),
      database: config?.database ?? process.env.POSTGRES_DB ?? "egaop",
      user: config?.user ?? process.env.POSTGRES_USER ?? "egaop",
      password: config?.password ?? process.env.POSTGRES_PASSWORD ?? "",
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  async findById(id: string): Promise<AgentRow | null> {
    const result = await this.pool.query(
      `SELECT id, namespace, name, api_version, kind, spec, status, labels, annotations,
              version, created_by, created_at, updated_at, deleted_at
       FROM agents
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]!);
  }

  async findByNamespaceAndName(namespace: string, name: string): Promise<AgentRow | null> {
    const result = await this.pool.query(
      `SELECT id, namespace, name, api_version, kind, spec, status, labels, annotations,
              version, created_by, created_at, updated_at, deleted_at
       FROM agents
       WHERE namespace = $1 AND name = $2 AND deleted_at IS NULL`,
      [namespace, name]
    );
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]!);
  }

  async listByNamespace(
    namespace: string,
    options?: {
      phase?: string;
      labels?: Record<string, string>;
      search?: string;
      cursor?: string;
      pageSize?: number;
    }
  ): Promise<{ agents: AgentRow[]; nextCursor: string; totalCount: number }> {
    const pageSize = Math.min(options?.pageSize ?? 50, 100);

    let whereClause = "WHERE namespace = $1 AND deleted_at IS NULL";
    const params: unknown[] = [namespace];
    let paramIndex = 2;

    if (options?.phase) {
      whereClause += ` AND status->>'phase' = $${paramIndex++}`;
      params.push(options.phase);
    }

    if (options?.labels && typeof options.labels === "object") {
      for (const [k, v] of Object.entries(options.labels)) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(k) || k.length > 63) {
          throw Object.assign(new Error(`Invalid label key: ${k}`), { code: "INVALID_ARGUMENT" });
        }
        whereClause += ` AND labels->>'${k}' = $${paramIndex++}`;
        params.push(v);
      }
    }

    if (options?.search) {
      whereClause += ` AND name ILIKE $${paramIndex++}`;
      params.push(`%${options.search}%`);
    }

    if (options?.cursor) {
      whereClause += ` AND id > $${paramIndex++}`;
      params.push(options.cursor);
    }

    const countResult = await this.pool.query(
      `SELECT COUNT(*) as total FROM agents ${whereClause}`,
      params
    );
    const totalCount = parseInt(countResult.rows[0]!["total"] as string, 10);

    const result = await this.pool.query(
      `SELECT id, namespace, name, api_version, kind, spec, status, labels, annotations,
              version, created_by, created_at, updated_at, deleted_at
       FROM agents ${whereClause}
       ORDER BY id ASC
       LIMIT $${paramIndex}`,
      [...params, pageSize]
    );

    const agents = result.rows.map((row: unknown) => this.mapRow(row as Record<string, unknown>));
    const nextCursor = agents.length === pageSize ? agents[agents.length - 1]!.id : "";

    return { agents, nextCursor, totalCount };
  }

  async create(params: {
    namespace: string;
    name: string;
    apiVersion?: string;
    kind?: string;
    spec?: Record<string, unknown>;
    status?: Record<string, unknown>;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    createdBy?: string;
  }): Promise<AgentRow> {
    const id = crypto.randomUUID();
    const apiVersion = params.apiVersion ?? "egaop.io/v1";
    const kind = params.kind ?? "Agent";
    const spec = params.spec ?? {};
    const status = params.status ?? { phase: "Pending", health_status: "Healthy" };
    const labels = params.labels ?? {};
    const annotations = params.annotations ?? {};
    const createdBy = params.createdBy ?? "";

    const result = await this.pool.query(
      `INSERT INTO agents (id, namespace, name, api_version, kind, spec, status, labels, annotations, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10)
       RETURNING id, namespace, name, api_version, kind, spec, status, labels, annotations,
                 version, created_by, created_at, updated_at, deleted_at`,
      [id, params.namespace, params.name, apiVersion, kind,
       JSON.stringify(spec), JSON.stringify(status), JSON.stringify(labels), JSON.stringify(annotations),
       createdBy]
    );

    return this.mapRow(result.rows[0]!);
  }

  async update(
    namespace: string,
    name: string,
    params: {
      spec?: Record<string, unknown>;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
      changeSummary?: string;
    }
  ): Promise<AgentRow | null> {
    const sets: string[] = [];
    const setValues: unknown[] = [];
    let paramIndex = 3;

    // Create version snapshot before updating
    const currentAgent = await this.findByNamespaceAndName(namespace, name);
    if (currentAgent) {
      try {
        await this.createVersionSnapshot(
          currentAgent.id, namespace, name, currentAgent.version,
          currentAgent.spec, currentAgent.labels, currentAgent.annotations,
          params.changeSummary ? "user" : "system",
          params.changeSummary || `Updated to v${currentAgent.version + 1}`
        );
      } catch {
        // Version snapshot failure is non-fatal
      }
    }

    if (params.spec) {
      sets.push(`spec = spec || $${paramIndex++}::jsonb`);
      setValues.push(JSON.stringify(params.spec));
    }
    if (params.labels) {
      sets.push(`labels = labels || $${paramIndex++}::jsonb`);
      setValues.push(JSON.stringify(params.labels));
    }
    if (params.annotations) {
      sets.push(`annotations = annotations || $${paramIndex++}::jsonb`);
      setValues.push(JSON.stringify(params.annotations));
    }

    if (sets.length === 0) {
      return this.findByNamespaceAndName(namespace, name);
    }

    sets.push(`version = version + 1`);
    sets.push(`updated_at = NOW()`);

    const result = await this.pool.query(
      `UPDATE agents
       SET ${sets.join(", ")}
       WHERE namespace = $1 AND name = $2 AND deleted_at IS NULL
       RETURNING id, namespace, name, api_version, kind, spec, status, labels, annotations,
                 version, created_by, created_at, updated_at, deleted_at`,
      [namespace, name, ...setValues]
    );

    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]!);
  }

  async softDelete(namespace: string, name: string): Promise<AgentRow | null> {
    const result = await this.pool.query(
      `UPDATE agents
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE namespace = $1 AND name = $2 AND deleted_at IS NULL
       RETURNING id, namespace, name, api_version, kind, spec, status, labels, annotations,
                 version, created_by, created_at, updated_at, deleted_at`,
      [namespace, name]
    );
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]!);
  }

  // ─── Agent Version History ─────────────────────────────────────────────

  async createVersionSnapshot(agentId: string, namespace: string, name: string, version: number, spec: Record<string, unknown>, labels: Record<string, string>, annotations: Record<string, string>, createdBy: string, changeSummary: string = ""): Promise<AgentVersionRow> {
    const id = crypto.randomUUID();
    const result = await this.pool.query(
      `INSERT INTO agent_versions (id, agent_id, namespace, name, version, spec, labels, annotations, created_by, change_summary)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
       RETURNING id, agent_id, namespace, name, version, spec, labels, annotations, created_by, created_at, change_summary`,
      [id, agentId, namespace, name, version, JSON.stringify(spec), JSON.stringify(labels), JSON.stringify(annotations), createdBy, changeSummary]
    );
    return this.mapVersionRow(result.rows[0]!);
  }

  async getVersionHistory(namespace: string, name: string, limit: number = 50): Promise<AgentVersionRow[]> {
    const result = await this.pool.query(
      `SELECT id, agent_id, namespace, name, version, spec, labels, annotations, created_by, created_at, change_summary
       FROM agent_versions
       WHERE namespace = $1 AND name = $2
       ORDER BY version DESC
       LIMIT $3`,
      [namespace, name, limit]
    );
    return result.rows.map((row) => this.mapVersionRow(row));
  }

  async getVersion(namespace: string, name: string, version: number): Promise<AgentVersionRow | null> {
    const result = await this.pool.query(
      `SELECT id, agent_id, namespace, name, version, spec, labels, annotations, created_by, created_at, change_summary
       FROM agent_versions
       WHERE namespace = $1 AND name = $2 AND version = $3`,
      [namespace, name, version]
    );
    if (result.rows.length === 0) return null;
    return this.mapVersionRow(result.rows[0]!);
  }

  async rollbackToVersion(namespace: string, name: string, targetVersion: number): Promise<AgentRow | null> {
    const versionSnapshot = await this.getVersion(namespace, name, targetVersion);
    if (!versionSnapshot) return null;

    const currentAgent = await this.findByNamespaceAndName(namespace, name);
    if (!currentAgent) return null;

    // Save current version as a snapshot before rollback
    await this.createVersionSnapshot(
      currentAgent.id, namespace, name, currentAgent.version,
      currentAgent.spec, currentAgent.labels, currentAgent.annotations,
      "system", `Auto-saved before rollback to v${targetVersion}`
    );

    // Restore the target version's spec, labels, and annotations
    const result = await this.pool.query(
      `UPDATE agents
       SET spec = $3::jsonb, labels = $4::jsonb, annotations = $5::jsonb,
           version = version + 1, updated_at = NOW()
       WHERE namespace = $1 AND name = $2 AND deleted_at IS NULL
       RETURNING id, namespace, name, api_version, kind, spec, status, labels, annotations,
                 version, created_by, created_at, updated_at, deleted_at`,
      [namespace, name, JSON.stringify(versionSnapshot.spec), JSON.stringify(versionSnapshot.labels), JSON.stringify(versionSnapshot.annotations)]
    );

    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]!);
  }

  // ─── Schema bootstrap ──────────────────────────────────────────────────

  async ensureVersionTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_versions (
        id UUID PRIMARY KEY,
        agent_id UUID NOT NULL,
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        spec JSONB NOT NULL DEFAULT '{}',
        labels JSONB NOT NULL DEFAULT '{}',
        annotations JSONB NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        change_summary TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_agent_versions_ns_name ON agent_versions (namespace, name);
      CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_id ON agent_versions (agent_id);
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private mapRow(row: Record<string, unknown>): AgentRow {
    return {
      id: row["id"] as string,
      namespace: row["namespace"] as string,
      name: row["name"] as string,
      api_version: row["api_version"] as string,
      kind: row["kind"] as string,
      spec: typeof row["spec"] === "string" ? JSON.parse(row["spec"] as string) : (row["spec"] as Record<string, unknown>),
      status: typeof row["status"] === "string" ? JSON.parse(row["status"] as string) : (row["status"] as Record<string, unknown>),
      labels: typeof row["labels"] === "string" ? JSON.parse(row["labels"] as string) : (row["labels"] as Record<string, string>),
      annotations: typeof row["annotations"] === "string" ? JSON.parse(row["annotations"] as string) : (row["annotations"] as Record<string, string>),
      version: parseInt(row["version"] as string, 10),
      created_by: row["created_by"] as string,
      created_at: row["created_at"] as string,
      updated_at: row["updated_at"] as string,
      deleted_at: row["deleted_at"] as string | null,
    };
  }

  private mapVersionRow(row: Record<string, unknown>): AgentVersionRow {
    return {
      id: row["id"] as string,
      agent_id: row["agent_id"] as string,
      namespace: row["namespace"] as string,
      name: row["name"] as string,
      version: parseInt(row["version"] as string, 10),
      spec: typeof row["spec"] === "string" ? JSON.parse(row["spec"] as string) : (row["spec"] as Record<string, unknown>),
      labels: typeof row["labels"] === "string" ? JSON.parse(row["labels"] as string) : (row["labels"] as Record<string, string>),
      annotations: typeof row["annotations"] === "string" ? JSON.parse(row["annotations"] as string) : (row["annotations"] as Record<string, string>),
      created_by: row["created_by"] as string,
      created_at: row["created_at"] as string,
      change_summary: row["change_summary"] as string,
    };
  }
}

let instance: AgentRepository | null = null;

export function getAgentRepository(): AgentRepository {
  if (!instance) {
    instance = new AgentRepository();
  }
  return instance;
}

export function resetAgentRepository(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
