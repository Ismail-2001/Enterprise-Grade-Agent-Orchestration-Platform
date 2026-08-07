# Security

## Current Status

- **Container image scanning**: Active in CI via Trivy. Every PR that modifies a `Dockerfile` or `docker-compose.yml` triggers a Trivy scan on `docker-build`. High/critical findings block the merge.
- **Security audit**: Completed. 6 findings identified and remediated (see `docs/production-readiness-final.md`).
- **Crypto**: V1 (AES-256-CBC) has been fully removed. Only V2 (AES-256-GCM) remains. No migration path exists — old V1-encrypted secrets must be re-encrypted before upgrade.
- **WebSocket auth**: All WebSocket endpoints now require a valid JWT token in the `Authorization` header during the initial handshake. Unauthenticated connections are rejected with `401`.

## Reporting a Vulnerability

If you discover a security issue in E-GAOP, please report it privately:

1. **Do not** open a public GitHub issue.
2. Send details to the repository maintainer via GitHub's security advisory tool at:
   `https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents/security/advisories/new`
3. Include:
   - Component affected (service name, port)
   - Type of vulnerability (XSS, injection, auth bypass, etc.)
   - Steps to reproduce
   - Potential impact

## What's Implemented

- OPA policy enforcement for agent execution authorization
- JWT authentication for API access
- JWT authentication for WebSocket endpoints
- Encrypted secret storage (AES-256-GCM, Postgres-backed)
- Sandbox network isolation (egaop-sandbox internal network)
- TLS encryption for gRPC
- mTLS (server requests client certs — verification disabled pending upstream fix)
- Container image scanning via Trivy in CI (docker-build workflow)
- Security audit completed with 6 remediated findings

## What's Not Implemented

- mTLS client-cert verification (blocked by @grpc/grpc-js upstream bug)
- Penetration testing (not performed)
- Automated secret scanning in CI (not configured)

See `docs/production-readiness-final.md` for the full security assessment.
