# E-GAOP Helm Chart

Kubernetes deployment for the Enterprise-Grade Agent Orchestration Platform.

## Prerequisites

- Kubernetes 1.25+
- Helm 3.10+
- PostgreSQL (bitnami/postgresql)
- Redis (bitnami/redis)
- Temporal (bitnami/temporal)
- Optional: cert-manager for TLS, External Secrets Operator for Vault

## Quick Start

```bash
# Install with defaults (dev/minikube)
helm install egaop charts/e-gaop -n egaop --create-namespace

# Install with staging values
helm install egaop charts/e-gaop -n egaop-staging \
  --values charts/e-gaop/values.yaml \
  --values charts/e-gaop/values-staging.yaml

# Install with production values
helm install egaop charts/e-gaop -n egaop-prod \
  --values charts/e-gaop/values.yaml \
  --values charts/e-gaop/values-production.yaml
```

## Configuration

### Global

| Key | Default | Description |
|-----|---------|-------------|
| `global.imageRegistry` | `ghcr.io` | Container image registry |
| `global.storageClass` | `""` | Storage class for PVCs |
| `global.serviceMonitorEnabled` | `false` | Create ServiceMonitor CRDs |

### Multi-Model LLM

| Key | Default | Description |
|-----|---------|-------------|
| `llm-router.openaiApiKey` | `""` | OpenAI API key |
| `llm-router.anthropicApiKey` | `""` | Anthropic API key |
| `llm-router.anthropicBaseUrl` | `https://api.anthropic.com` | Anthropic API base URL |
| `llm-router.ollamaBaseUrl` | `http://localhost:11434` | Ollama local model URL |
| `llm-router.fallbackChain` | `gpt-4o,gpt-4o-mini,gpt-3.5-turbo` | Model fallback order |

### Sandbox Isolation

| Key | Default | Description |
|-----|---------|-------------|
| `workflow-engine.sandboxIsolationLevel` | `Enhanced` | gVisor sandbox level (Standard/Enhanced) |

### Database Migration

| Key | Default | Description |
|-----|---------|-------------|
| `migration.enabled` | `true` | Run migration Job on install/upgrade |
| `migration.image` | `postgres` | Migration container image |
| `migration.tag` | `16` | Migration container tag |

### Secrets

| Key | Default | Description |
|-----|---------|-------------|
| `secrets.jwtSecret` | `""` | JWT signing secret |
| `secrets.postgresPassword` | `""` | PostgreSQL password |
| `secrets.redisPassword` | `""` | Redis password |
| `secrets.masterEncryptionKey` | `""` | Master encryption key |

> **Production**: Use External Secrets Operator with Vault instead of static secrets.

```yaml
externalSecrets:
  enabled: true
  vault:
    address: "https://vault.egaop.io:8200"
    path: "secret/data/egaop"
```

## Upgrades

```bash
helm upgrade egaop charts/e-gaop -n egaop \
  --values charts/e-gaop/values.yaml \
  --values charts/e-gaop/values-production.yaml \
  --wait --timeout 10m
```

The migration Job runs automatically on every `helm upgrade` as a pre-upgrade hook.

## Rollback

```bash
# Rollback to previous revision
helm rollback egaop -n egaop

# Rollback to specific revision
helm rollback egaop 3 -n egaop
```

## Validation

```bash
# Lint
helm lint charts/e-gaop --strict

# Template (default)
helm template test charts/e-gaop

# Template (staging)
helm template test charts/e-gaop \
  --values charts/e-gaop/values.yaml \
  --values charts/e-gaop/values-staging.yaml

# Template (production) + kubeconform
helm template test charts/e-gaop \
  --values charts/e-gaop/values.yaml \
  --values charts/e-gaop/values-production.yaml \
  | kubeconform -strict
```

## Architecture

```
charts/e-gaop/
├── templates/           # Parent chart templates (ingress, networkpolicy, migration, secrets)
├── migrations/          # SQL migration files (001-008)
└── charts/
    ├── api-server/
    ├── workflow-engine/
    ├── llm-router/
    ├── tool-proxy/
    ├── sandbox-runtime/
    ├── memory-plane/
    ├── observability-plane/
    ├── secret-store/
    └── admin-console/
```
