# Troubleshooting

## npm Hoisting Bug (grpc/proto-loader incomplete)

**Symptom**: `Cannot find module '@grpc/grpc-js'` or missing `@grpc/proto-loader` sub-dependencies after `npm install`.

**Cause**: npm hoists dependencies to the root `node_modules/`. Individual workspace packages may reference sub-dependencies that get deduplicated incorrectly.

**Fix**:

```bash
# Nuclear option — clean and reinstall
rm -rf node_modules package-lock.json
npm install

# Or, if only one workspace is broken
npm install -w <workspace-name>
```

If the issue persists, check that `@grpc/grpc-js` and `@grpc/proto-loader` versions match across all workspace `package.json` files.

## mTLS Handshake Failure

**Symptom**: `Error: 14 UNAVAILABLE: connection error` or `SSL_ERROR_SYSCALL` when `MTLS_ENABLED=true`.

**Cause**: Upstream `@grpc/grpc-js` v1.14.x has a known bug where client certificate verification fails intermittently under load.

**Fix**:

- Set `MTLS_ENABLED=false` in `.env` (default). TLS-only mode encrypts traffic without requiring client certs.
- mTLS is experimental — do not enable in production until the upstream fix is merged.

## Temporal Connection Refused

**Symptom**: `workflow-engine` logs `ConnectError: connection refused` to Temporal.

**Cause**: Temporal takes 2–3 minutes to initialise on first boot.

**Fix**:

```bash
# Check Temporal health
docker compose logs temporal --tail 50

# Wait and retry — the healthcheck uses a 120s start_period
docker compose up -d temporal
# Wait 2 minutes, then check
docker compose ps temporal
```

If Temporal is still unhealthy, ensure `POSTGRES_PASSWORD` is set in `.env` (the compose file uses `:?` which will error if empty).

## Port Conflicts

**Symptom**: `Bind for 0.0.0.0:3001 failed: port is already allocated`.

**Cause**: Another process is using the required port.

**Fix**:

```bash
# Find what's using the port (Linux/Mac)
lsof -i :3001

# On Windows
netstat -ano | findstr :3001

# Kill the process or change the port in docker-compose.yml / .env
```

Required ports: `3001` (REST API), `50051` (gRPC), `3003` (Grafana), `8080` (Temporal UI).

## Docker Compose Network Issues

**Symptom**: Services can't resolve each other by name, or `docker compose up` fails with network errors.

**Cause**: Stale Docker networks or the `egaop-net` network name collision.

**Fix**:

```bash
# Remove all project containers and networks
docker compose down -v --remove-orphans

# Prune dangling networks
docker network prune

# Restart
docker compose up -d
```

Ensure Docker Desktop has enough resources (Settings > Resources): **4 GB RAM** minimum, **8 GB** recommended.

## TypeScript Build Errors

**Symptom**: `tsc` fails with `Cannot find module` or type errors after pulling latest.

**Cause**: Build order matters — `packages/shared` must be built first.

**Fix**:

```bash
# Full rebuild in correct order
rm -rf packages/shared/dist control-plane/*/dist execution-plane/*/dist memory-plane/dist observability-plane/dist
npm run build

# Or build shared first, then everything
npm run build -w packages/shared
npm run build --workspaces --if-present
```

If you see `TS2307: Cannot find module './types'`, check that `tsconfig.base.json` is present at the root (it's copied into Docker builds).

## Test Failures (Jest Globals)

**Symptom**: Tests fail with `ReferenceError: describe is not defined` or similar.

**Cause**: The root `jest.config.ts` uses `globals` with `ts-jest` configuration. If a workspace overrides the root config, it may lose the `@types/jest` types.

**Fix**:

```bash
# Ensure @types/jest is installed
npm ls @types/jest

# If missing, add to the workspace's devDependencies:
npm install -D @types/jest

# Run tests from the root to use the shared jest.config.ts
npm test --workspaces --if-present
```

If tests use `testcontainers`, ensure Docker is running and the `testcontainers` package version matches across workspaces.

## General Debugging Tips

```bash
# Tail logs for a specific service
docker compose logs -f api-server

# Check all service health
docker compose ps

# Inspect a container's environment
docker compose exec api-server env | sort

# Open a shell in a running container
docker compose exec api-server sh

# Check gRPC health (requires grpcurl)
grpcurl -plaintext localhost:50051 grpc.health.v1.Health/Check
```
