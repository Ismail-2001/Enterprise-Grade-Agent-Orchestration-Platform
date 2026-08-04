# Scaling Runbook

## Horizontal Scaling

### Check Current Autoscaling

```bash
# HPA status
kubectl get hpa -n egaop

# Detailed HPA status
kubectl describe hpa -n egaop

# Current vs desired replicas
kubectl get deployments -n egaop -o custom-columns=NAME:.metadata.name,READY:.status.readyReplicas,DESIRED:.spec.replicas
```

### Manual Scale (Emergency)

```bash
# Scale API server
kubectl scale deployment/api-server -n egaop --replicas=5

# Scale LLM router
kubectl scale deployment/llm-router -n egaop --replicas=3

# Scale workflow engine
kubectl scale deployment/workflow-engine -n egaop --replicas=3
```

### Adjust HPA Thresholds

```bash
# Edit HPA via Helm values
helm upgrade egaop ./charts/e-gaop \
  -f ./charts/e-gaop/values-production.yaml \
  -n egaop \
  --set api-server.autoscaling.targetCPUUtilizationPercentage=60 \
  --reuse-values
```

## Vertical Scaling

### Increase Memory Limits

```bash
# Edit deployment directly
kubectl patch deployment api-server -n egaop -p '{"spec":{"template":{"spec":{"containers":[{"name":"api-server","resources":{"limits":{"memory":"2Gi"}}}]}}}}'
```

### Increase CPU Limits

```bash
kubectl patch deployment llm-router -n egaop -p '{"spec":{"template":{"spec":{"containers":[{"name":"llm-router","resources":{"limits":{"cpu":"2"}}}]}}}}'
```

## Database Scaling

### Connection Pool Tuning

```bash
# Check current pool settings
kubectl get configmap -n egaop -o yaml | grep -A5 POSTGRES

# Update pool size
kubectl patch configmap egaop-config -n egaop -p '{"data":{"POSTGRES_MAX_CONNECTIONS":"50"}}'
```

### Read Replica Setup

```bash
# For PostgreSQL, add read replica
helm upgrade egaop ./charts/e-gaop \
  -f ./charts/e-gaop/values-production.yaml \
  -n egaop \
  --set postgresql.readReplicas.enabled=true \
  --set postgresql.readReplicas.replicaCount=2
```

## Resource Quotas

### Check Namespace Quotas

```bash
kubectl get resourcequota -n egaop
kubectl describe resourcequota -n egaop
```

### Increase Quotas

```bash
kubectl patch resourcequota egaop-quota -n egaop -p '{"spec":{"hard":{"requests.cpu":"20","requests.memory":"40Gi","limits.cpu":"40","limits.memory":"80Gi"}}}'
```

## Scaling Guidelines

| Service | Min Replicas | Max Replicas | Target CPU | Target Memory |
|---------|-------------|-------------|------------|---------------|
| api-server | 2 | 10 | 70% | 80% |
| llm-router | 2 | 8 | 60% | 70% |
| workflow-engine | 2 | 6 | 70% | 80% |
| tool-proxy | 2 | 6 | 70% | 80% |
| memory-plane | 2 | 4 | 70% | 80% |
| observability-plane | 2 | 4 | 70% | 80% |

## When to Scale

- **CPU > 70%** for 5 minutes → HPA should auto-scale
- **Memory > 80%** → increase memory limits
- **p95 latency > 1s** → check if scaling needed
- **Error rate > 1%** → check if scaling needed
- **Pod restarts > 3** → check OOM, scale memory
