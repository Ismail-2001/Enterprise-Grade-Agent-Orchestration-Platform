# E-GAOP GitOps with ArgoCD

This directory contains ArgoCD manifests for GitOps-based deployment of the E-GAOP platform.

## Prerequisites

- Kubernetes cluster with ArgoCD installed
- `kubectl` configured with cluster access
- `argocd` CLI installed (optional, for local management)

## Quick Start

### 1. Install ArgoCD (if not already installed)

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

### 2. Bootstrap E-GAOP

```bash
kubectl apply -k gitops/
```

This creates:
- **AppProject `egaop`** — source repos, destinations, RBAC, sync windows
- **Application `egaop-staging`** — auto-syncs from `main` branch, prunes removed resources
- **Application `egaop-production`** — self-heals only, no auto-prune (manual sync required)

### 3. Access ArgoCD UI

```bash
kubectl port-forward svc/argocd-server -n argocd 8080:443
```

Open https://localhost:8080 and log in with the initial admin password:
```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d
```

## Environments

| Environment | Namespace | Auto-Sync | Prune | Self-Heal | Sync Window |
|-------------|-----------|-----------|-------|-----------|-------------|
| Staging | `egaop-staging` | Yes | Yes | Yes | Daily 02:00-06:00 UTC |
| Production | `egaop-production` | No | No | Yes | Weekdays 00:00-08:00 UTC (deny) |

## Deployment Workflow

### Staging (Automatic)

1. Push to `main` branch
2. ArgoCD detects changes within 3 minutes
3. Application syncs automatically
4. Health checks verify rollout

### Production (Manual)

1. Push to `main` branch
2. ArgoCD detects changes but does NOT auto-sync
3. Review changes in ArgoCD UI
4. Manually trigger sync:
   ```bash
   argocd app sync egaop-production
   ```
   Or via UI: Applications → egaop-production → SYNC

### Rollback

```bash
# List history
argocd app history egaop-production

# Rollback to previous revision
argocd app rollback egaop-production <revision>
```

## Sync Policies

- **Automated (staging):** ArgoCD auto-syncs on git changes, prunes removed resources, self-heals drift
- **Manual (production):** Only self-heals; sync requires manual trigger via UI or CLI
- **Retry:** Exponential backoff (5s→10s→20s... up to maxDuration) on transient failures
- **Prune propagation:** Foreground deletion ensures dependent resources are removed first

## Health Checks

ArgoCD uses Kubernetes health checks for all resource types:
- **Deployments:** RollingUpdate strategy health
- **StatefulSets:** RollingUpdate strategy health
- **HPA:** Min/max replicas within bounds
- **PDB:** MinAvailable/MaxUnavailable satisfied
- **Services:** Endpoints populated

## RBAC Roles

| Role | Permissions | Groups |
|------|-------------|--------|
| `ci` | sync, get | `ci-egaop` |
| `developer` | get, sync, action/* | `dev-egaop` |

## Sync Windows

| Window | Kind | Schedule | Duration | Scope |
|--------|------|----------|----------|-------|
| Staging auto-sync | allow | `0 2 * * *` | 4h | All apps |
| Production freeze | deny | `0 0 * * 1-5` | 8h | `egaop-production` only |

## Directory Structure

```
gitops/
├── app-project.yaml          # ArgoCD AppProject definition
├── application-staging.yaml  # Staging Application (auto-sync)
├── application-production.yaml # Production Application (manual sync)
├── kustomization.yaml        # Kustomize entrypoint
└── README.md                 # This file
```

## Upgrading ArgoCD

```bash
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

## Troubleshooting

### Sync failed

```bash
argocd app get egaop-staging
argocd app logs egaop-staging
```

### Application stuck in "Progressing"

Check pod events:
```bash
kubectl describe pods -n egaop-staging
```

### Production sync blocked by sync window

Wait for the window to close, or manually override:
```bash
argocd app sync egaop-production --force
```
