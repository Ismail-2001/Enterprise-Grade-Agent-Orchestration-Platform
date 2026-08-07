# Contributing to E-GAOP

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js 24** (`.nvmrc` pins this — run `nvm use`)
- **Docker Engine 24+** with Compose v2
- **git**
- **grpcurl** (optional, for manual gRPC testing)
- **jq** (optional, for pretty-printing JSON in curl examples)

## Local Development Setup

```bash
# 1. Clone and install
git clone https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents.git
cd The-Kubernetes-of-AI-Agents
npm install

# 2. Configure
cp .env.example .env
# Fill in OPENAI_API_KEY, JWT_SECRET, POSTGRES_PASSWORD, etc.

# 3. Start infrastructure
docker compose up -d

# 4. Run all services in dev mode
npm run dev
```

## Running Tests, Typecheck, and Lint

```bash
# Tests (unit + integration — uses testcontainers for Postgres/Redis)
npm test --workspaces --if-present

# Typecheck all workspaces
npm run typecheck --workspaces --if-present

# Lint all workspaces
npm run lint --workspaces --if-present
```

Run these before every commit — CI will reject PRs that fail.

## Architecture Overview

E-GAOP follows a **5-plane, 10-service** architecture with gRPC inter-service communication:

| Plane              | Services                                              | Port Range   |
|---------------------|-------------------------------------------------------|-------------|
| **Control Plane**   | `api-server`, `secret-store`, `workflow-engine`       | 50051–50058 |
| **Execution Plane** | `llm-router`, `tool-proxy`, `sandbox-runtime`         | 50052–50054 |
| **Memory Plane**    | `memory-plane`                                        | 50055       |
| **Observability**   | `observability-plane`                                 | 50056       |
| **Policy Plane**    | `policy-plane` (OPA sidecar)                          | 50053       |

All inter-service communication uses **gRPC with TLS**. Services authenticate each other via `x-service-token` header. The `workflow-engine` uses **Temporal** for durable DAG orchestration.

## How to Add a New Service

### 1. Create the workspace

```bash
mkdir -p my-new-service/src
cd my-new-service
npm init -y
```

### 2. Add to root `package.json` workspaces

```json
"workspaces": [
  "packages/shared",
  "control-plane/api-server",
  ...
  "my-new-service"
]
```

### 3. Create `my-new-service/package.json`

Follow the pattern of existing services:

```json
{
  "name": "@egaop/my-new-service",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "tsc",
    "dev": "ts-node src/index.ts",
    "start": "node dist/index.js",
    "test": "jest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/"
  }
}
```

### 4. Create `my-new-service/Dockerfile`

Use the multi-stage pattern from `control-plane/api-server/Dockerfile`:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY my-new-service/package.json ./my-new-service/
RUN npm install --ignore-scripts
RUN npm run build -w packages/shared
COPY my-new-service/tsconfig.json ./my-new-service/
COPY my-new-service/src/ ./my-new-service/src/
RUN npm run build -w my-new-service

FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 egaop && adduser --system --uid 1001 egaop
COPY --from=builder /app/my-new-service/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/my-new-service/package.json ./
USER egaop
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:15099/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist/index.js"]
```

### 5. Add to `docker-compose.yml`

Follow the pattern of existing services — include `depends_on`, `healthcheck`, `networks`, and `deploy.resources`.

## How to Add a New Tool

Tools are defined in `packages/shared/src/sandbox/executor.ts` using the `TOOL_EXECUTORS` pattern:

```typescript
const TOOL_EXECUTORS: Record<string, (args: Record<string, unknown>) => Promise<ExecResult>> = {
  // ...existing tools...

  my_new_tool: async (args) => {
    const { param } = MY_SCHEMA.parse(args); // validate with Zod
    return runTool(["some-command", param]);
  },
};
```

After adding the entry, update `ALLOWED_TOOLS` is automatic — it's derived from `Object.keys(TOOL_EXECUTORS)`.

## Protobuf Conventions

All `.proto` files live in `api/proto/`:

```
api/proto/
├── egaop/v1/        # Platform resource definitions (AgentSpec, etc.)
└── grpc/            # Generic gRPC service definitions
```

Rules:
- Follow standard protobuf backward-compatibility (never remove or reorder fields)
- Use `egaop.io/v1` as the API version prefix
- Run `npm run build` after changes to regenerate typed stubs

## Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | LLM provider API key |
| `JWT_SECRET` | Yes | — | Token signing secret (64-char hex) |
| `POSTGRES_PASSWORD` | Yes | — | Database password |
| `GRAFANA_PASSWORD` | Yes | — | Grafana admin password |
| `EGAOP_MASTER_ENCRYPTION_KEY` | Yes | — | AES-256-GCM key for secrets |
| `INTERNAL_SERVICE_TOKEN` | Yes | — | gRPC service-to-service auth |
| `TLS_ENABLED` | No | `true` | Enable TLS for gRPC |
| `MTLS_ENABLED` | No | `false` | Enable client-cert verification (experimental) |
| `SANDBOX_ISOLATION_LEVEL` | No | `Enhanced` | `Standard`, `Enhanced`, or `Maximum` |
| `LLM_FALLBACK_CHAIN` | No | `gpt-4o,gpt-4o-mini,gpt-3.5-turbo` | Comma-separated model fallback |
| `RATE_LIMIT_LLM_RPM` | No | `30` | LLM requests per minute |
| `RATE_LIMIT_TOOL_PROXY_RPM` | No | `60` | Tool proxy requests per minute |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |

See `.env.example` for the complete list with descriptions.

## Pre-Commit Hooks

Husky + lint-staged run automatically on every commit:

- `*.ts` / `*.tsx` files: `eslint --fix` then `tsc --noEmit`
- Pre-commit hook: `.husky/pre-commit` runs `npx lint-staged`

To bypass (not recommended): `git commit --no-verify`

## Code Style

- **TypeScript strict mode** — no `any` types. Use `unknown` and narrow with type guards.
- **No comments** — code should be self-documenting. If a comment is needed, the code needs refactoring.
- **Zod for validation** — all external input must be parsed through Zod schemas.
- **No barrel exports** — import directly from the source file.
- **Named exports only** — no default exports.
- **Prettier + ESLint** — the existing `.eslintrc.json` configures both.

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new capability
- `fix:` — bug fix
- `docs:` — documentation changes
- `refactor:` — code restructuring
- `chore:` — tooling, dependencies, CI

## Pull Request Process

1. Ensure `npm test`, `npm run typecheck`, and `npm run lint` pass across all workspaces.
2. Write atomic commits with descriptive messages.
3. Self-review for security implications, especially in `policy-plane/` and `execution-plane/`.
4. Link any related PR descriptions in `prs/` for traceability.

## Reporting Issues

Use the issue templates (see `.github/ISSUE_TEMPLATE/`). Include:
- E-GAOP version (git commit hash)
- Component (e.g., llm-router, workflow-engine)
- Expected vs actual behavior
- Relevant logs or traces

---

> **Note on production readiness:** This project has a published readiness assessment at `docs/production-readiness-final.md`. Known limitations are documented there — please check before reporting capability gaps.
