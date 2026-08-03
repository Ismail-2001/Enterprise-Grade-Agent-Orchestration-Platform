# E-GAOP Developer Guide

A practical guide for engineers working on E-GAOP ("The Kubernetes of AI Agents"). Covers the development loop, architecture map, debugging, and security guidelines.

## Table of Contents

1. [Developer Environment](#developer-environment)
2. [Architecture Map](#architecture-map)
3. [Development Loop](#development-loop)
4. [Running Services Locally](#running-services-locally)
5. [Debugging](#debugging)
6. [Testing](#testing)
7. [Security Guidelines](#security-guidelines)
8. [Common Gotchas](#common-gotchas)

---

## Developer Environment

Prerequisites:

- **Node.js 24** (matches CI; `package.json` engines may be stricter)
- **npm** 10+ (workspaces + `npm ci --prefer-offline`)
- **Docker** (Compose for local stack; Buildx for image builds)
- **Helm 3** + optionally `kubeconform` (K8s chart work)
- **Temporal CLI** (workflow debugging)
- **psql** (pgvector/Postgres inspection)

First-time setup:

```bash
npm ci --prefer-offline --no-fund
# npm 11 hoisting workaround used by CI (only needed if proto-loader deps look broken):
npm dedupe
npm run build --workspace=packages/shared   # required before typechecking other workspaces
```

Never modify the root `package.json`. It is a wiring-only workspace; adding deps there breaks hoisting. Add dependencies to the owning workspace instead (e.g. `control-plane/api-server/package.json`).

## Architecture Map

E-GAOP is organized into five planes plus shared packages:

| Plane | Workspace(s) | Responsibility | Ports (default) |
|-------|--------------|----------------|-----------------|
| Control | `control-plane/api-server`, `workflow-engine`, `secret-store` | REST/gRPC API, Temporal workflows, encrypted secrets | 50051/8000, 7233 (Temporal), 50053 |
| Execution | `execution-plane/llm-router`, `tool-proxy`, `sandbox-runtime` | Model routing, tool calls, gVisor containers | 50052, 50054, 50055 |
| Memory | `memory-plane` | pgvector + Redis memory, WAL durable writes | 50056 |
| Policy | `policy-plane` | OPA/Rego enforcement, LRU cache, circuit breaker | 50057 |
| Observability | `observability-plane` | OTel, Prometheus, Grafana, 5 alert rules | 4318, 9090, 3000 |
| Shared | `packages/shared` | Types, audit chain, interceptors, rate limiter | — |

Cross-plane communication is **gRPC** (protos in `api/proto/egaop/v1/*.proto`) with **REST** on the api-server and internal service tokens via `INTERNAL_SERVICE_TOKEN`.

## Development Loop

```bash
# 1. Edit a proto? Regenerate/bump version, then update all consumers.
# 2. Make your change in a workspace.
# 3. Verify the full gate (mirrors CI):
npm run lint --workspaces --if-present
npm run build --workspace=packages/shared
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present -- --passWithNoTests
```

Commit with Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `security:`). Pre-push hooks may run a secret scan — never commit real credentials or fixture files containing live keys (use env-var names and test-only fixtures).

## Running Services Locally

The full 22-container stack:

```bash
docker compose up --build
```

Single-plane development (with deps stubbed via env):

```bash
# api-server alone (needs Postgres + Redis up)
docker compose up -d postgres redis
npm run dev --workspace=control-plane/api-server
```

Health endpoints:

- API: `GET http://localhost:8000/health` and `/api/health`
- Every plane: `GET :<healthPort>/healthz` and `/readyz` (e.g. tool-proxy `15052`, memory-plane `15056`)

Sandbox runtime specifics (`execution-plane/sandbox-runtime`):

- `SANDBOX_MAX_CONTAINERS` (default 20) — container slot limit; excess waits 5s then fails with `RESOURCE_EXHAUSTED`.
- `SANDBOX_SECCOMP_PROFILE` — set to a path to enable seccomp; a default profile ships at `execution-plane/sandbox-runtime/seccomp/default.json` (reference it via env; it is not auto-plumbed).
- Containers run with `CapDrop: ["ALL"]` and `no-new-privileges`; `Enhanced`/`Maximum` isolation select gVisor runtimes.

## Debugging

- **gRPC calls** — `grpcurl -plaintext localhost:<port> list` / `grpcurl -plaintext -d '{}' localhost:<port> egaop.v1.Health/Check`
- **Workflows** — `temporal workflow list --address localhost:7233` and `temporal workflow show --workflow-id <id>`
- **OPA** — `curl -X POST http://localhost:8181/v1/data/egaop/allow -d '{"input": {...}}'`
- **Postgres** — `docker compose exec postgres psql -U egaop -d egaop` (tables: `agents`, `namespaces`, `agent_memory`, `secrets`, `users`)
- **Redis** — `docker compose exec redis redis-cli KEYS 'egaop:*'`
- **WAL** — memory-plane durable writes are queued; check stderr JSON for `Memory durable write permanently failed` or `Memory write queue full` messages.
- **Logs** — pino JSON; set `LOG_LEVEL=debug`. Structured audit entries are chained via `createAuditEntry`.

## Testing

- **Unit tests** — Jest, mandatory for new logic. Suites live in `<workspace>/src/__tests__/`.
- **Integration/contract/chaos/security** — `tests/jest.config.ts` with project selectors (requires Docker for testcontainers):
  ```bash
  npx jest --config tests/jest.config.ts --selectProjects security --forceExit
  ```
- **Namespace isolation (integration)** — `tests/security/namespace-isolation.test.ts` needs a running full stack (gRPC on 50051/50052/50054/50055) and is skipped by default. Enable with `EGAOP_RUN_INTEGRATION_TESTS=1`; per-service addresses are overridable via `EGAOP_*_GRPC_ADDR` env vars.
- **PII detection** — `execution-plane/tool-proxy` exports `scanForPII`; patterns cover SSN, email, credit cards, US/international phones, DOB, IP. Extend `PII_PATTERNS` (not ad-hoc regexes) in `execution-plane/tool-proxy/src/index.ts`.
- **Retry policy** — `fetchWithRetry` in tool-proxy retries 5xx and network errors with exponential backoff (3 attempts); `AbortError` is never retried.

## Security Guidelines

Treat every service as exposed:

1. **Never rely on the default allowlist.** The SSRF/init-command allowlists (`ALLOWED_WEB_FETCH_HOSTS`, `ALLOWED_INIT_TOKEN_RE`) are defense-in-depth; keep them tight and add tests when expanding.
2. **JWT is fail-closed.** `JWT_SECRET` must be ≥32 chars or the api-server refuses to start. Revoked tokens are blacklisted in Redis (`egaop:revoked:<sha256>`).
3. **Secrets stay scoped.** `secret-store` rejects reads where `agent_id` namespace ≠ request namespace.
4. **Sandboxes are hardened.** Do not reintroduce `CapAdd`, bind-mount the Docker socket, or allow shell metacharacters in init commands.
5. **Secrets in code** — never commit real keys. Use env vars via `.env`/`.env.example` and `loadSecretsIntoEnv()`.

## Common Gotchas

- **`@grpc/proto-loader` build/ dir missing after install** — run `npm dedupe` (see CI workaround).
- **Typecheck fails in a workspace** — `packages/shared` must be built first: `npm run build --workspace=packages/shared`.
- **Test count drift** — README/badge and `docs/FAANG-AUDIT-REPORT.md` reference a test count (currently 297); update all three when adding suites.
- **Docker Compose validation** requires env vars set (see `docker-compose-validate` job in `.github/workflows/ci.yml`).
- **Windows shell** — this repo's scripts are POSIX-oriented; when running locally on Windows use `;` separators, not `&&`.
