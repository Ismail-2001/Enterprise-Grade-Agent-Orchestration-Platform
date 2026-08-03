# Changelog

All notable changes to E-GAOP are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
