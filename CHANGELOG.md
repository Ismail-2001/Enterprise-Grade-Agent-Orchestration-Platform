# Changelog

All notable changes to E-GAOP are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **SLO/SLI tracking (Phase 4 #30):** `SLOTracker` class in `packages/shared/src/slo/` computes SLI from OTel histograms/counters, tracks error budgets, and computes burn rates across 5/30/60-minute windows; defines 6 default SLOs (API availability, API latency p95, gRPC availability, gRPC latency p95, agent execution success, LLM latency p99).
- **`/api/slos` endpoint** in api-server: returns SLO snapshot with configurable window; exposes compliance status, error budget consumption, and burn-rate alerts.
- **Prometheus alerting rules** for SLO burn rates: 5-min (14.4x) page, 30-min (6x) page, 60-min (3x) ticket alerts; availability below 99.9%, p95 latency above 1s, and error budget exhaustion alerts.
- **Distributed trace propagation (Phase 4 #29):** W3C trace context extraction/insertion across all gRPC service boundaries via `createTraceServerInterceptor` (server) and updated `spanEnrichmentInterceptor` (client); auto-injects `traceparent` on outbound calls; propagates server span as active context for downstream handlers; wired into all 8 gRPC services (llm-router, tool-proxy, sandbox-runtime, secret-store, api-server, policy-plane, memory-plane, observability-plane) plus shared `GrpcServer` defaults.
- **k6 load testing in CI (Phase 4 #27):** Dedicated `load-test` GitHub Actions job boots API server with ephemeral Postgres/Redis, applies migrations, runs `tests/load/ci-smoke.js` (2 VUs × 10 iterations) exercising health, auth, namespaces, agents CRUD; enforces SLO thresholds (health p95 < 200ms, auth p95 < 1s, agent CRUD p95 < 1.5s, error rate < 1%); uploads k6 summary artifact.
- **CI smoke load test script** `tests/load/ci-smoke.js`: fast deterministic control-plane smoke scenario for PR gating.

### Observability

- Distributed trace propagation across all 8 services via W3C `traceparent` extraction/insertion; server spans created with SERVER kind + `namespace`/`agent.id` attributes; client spans use active context as parent instead of root; 6 new tests in `packages/shared/src/__tests__/trace-propagation.test.ts`.

### Testing

- Added 24 unit tests for SLO tracker (define/record, availability SLI, latency SLI, burn rates, window filtering, snapshot, clear/reset, DEFAULT_SLO_DEFINITIONS); added 6 unit tests for trace propagation; shared workspace test suite now 104 tests; full workspace suite now 360+ tests.

### Changed

- FAANG audit re-scored to **7.55/10** (Observability 9/10, Testing 7/10, Operability 8/10); Phase 4 items #27, #29, and #30 complete.

### Security

- Prompt injection gate applied to both `Generate` and `GenerateStream` handlers (Phase 3 #24).

### Tests

- Added 33 unit tests (tokenizers, prompt injection, streaming) — llm-router suite now 42 tests; added `.js`→`.ts` moduleNameMapper to llm-router + tests jest configs for NodeNext resolution.

### Changed

- FAANG audit re-scored to **7.30/10** (LLM Integration 9/10); all 8 Phase 3 (Medium) items now complete.

## [1.0.0] - 2026-08-03

### Security (Critical / High remediation)

- **Phase 1 (Critical):** JWT fail-closed on missing secret, authenticated DLQ admin endpoint, SSRF allowlist for `web_fetch`, verified Docker socket isolation, Rego policies loaded into OPA, JWT expiry enforcement + timing-safe signature comparison in policy plane.
- **Phase 2 (High):** Redis-backed JWT token revocation, label-key SQL-injection allowlist, ETag cache stores hash only, secret-store namespace-scoped access control, vector-search authentication, per-provider LLM circuit breakers, AbortSignal timeouts for Anthropic/Ollama, container cleanup on shutdown, sandbox container count limit, init-command token allowlist, seccomp profile + `CapDrop: ALL`.
- **Phase 3 (Medium):** Expanded PII detection (credit cards, phones, DOB, IP), retry with exponential backoff on 5xx/network errors, memory write-ahead log with durable retry queue, API versioning in response metadata + namespaces pagination.

### Quality

- Re-scored FAANG audit to **7.10/10** (up from 6.35); 0 lint errors/warnings across all 10 workspaces; `npm audit` **0 vulnerabilities**.
- Developer guide and runbooks published under `docs/`.
- **CI restored to green**: fixed the security test suite that had failed CI since it was introduced — exported `isPrivateOrInternalIP` from tool-proxy, corrected broken JWT/path-traversal/prototype-pollution assertions, guarded fuzzing against `undefined`, clamped NaN/negative token counts in `calculateCost`, and gated the namespace-isolation suite behind `EGAOP_RUN_INTEGRATION_TESTS=1` (documented integration test, skipped by default).

### Added

- Multi-model LLM routing (OpenAI + Anthropic + Ollama) with 3-model fallback chain.
- WebSocket streaming for execution events; SSE fallback.
- Agent versioning with rollback; dead-letter queue for failed executions.
- pgvector memory, Temporal workflows, OPA policy plane, OpenTelemetry + Prometheus + Grafana.
- Helm charts (11 sub-charts) with HPA, PDB, NetworkPolicy, ServiceMonitor, canary deployments.

### Tests

- 297 tests passing across 10 workspaces; contract, chaos, and security test projects.

[Unreleased]: https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents/releases/tag/v1.0.0
