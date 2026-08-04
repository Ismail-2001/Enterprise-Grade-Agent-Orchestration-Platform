# Incident Response Runbook

## SLO Breach Response

### 1. Availability Below 99.9%

```bash
# Identify affected service
kubectl get pods -n egaop -o wide | grep -v Running

# Check recent deployments (possible bad deploy)
helm history egaop -n egaop --max=5

# Check pod restarts
kubectl get pods -n egaop -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .status.containerStatuses[*]}{.restartCount}{"\n"}{end}{end}'

# Quick rollback if recent deploy
helm rollback egaop <LAST_KNOWN_GOOD> -n egaop
```

### 2. Latency Spike (p95 > 1s)

```bash
# Check resource pressure
kubectl top pods -n egaop

# Check HPA scaling
kubectl get hpa -n egaop

# Check for OOMKilled
kubectl get pods -n egaop -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .status.containerStatuses[*]}{.lastState.terminated.reason}{"\n"}{end}{end}' | grep OOMKilled

# Check Postgres connection pool
kubectl exec -n egaop deployment/api-server -- curl -s localhost:15051/healthz
```

### 3. Error Rate Spike

```bash
# Check logs for errors
kubectl logs -n egaop deployment/api-server --tail=100 | grep -i error

# Check circuit breaker state
kubectl exec -n egaop deployment/llm-router -- curl -s localhost:15053/healthz

# Check OPA policy engine
kubectl exec -n egaop deployment/opa -- wget -qO- http://localhost:8181/health
```

## Service Down Response

### API Server Down

```bash
# Check pod status
kubectl describe pod -n egaop -l app.kubernetes.io/name=api-server

# Check recent logs
kubectl logs -n egaop -l app.kubernetes.io/name=api-server --tail=200

# Restart deployment
kubectl rollout restart deployment/api-server -n egaop
kubectl rollout status deployment/api-server -n egaop
```

### Temporal Worker Down

```bash
# Check Temporal frontend
kubectl get pods -n egaop -l app.kubernetes.io/name=temporal

# Check workflow activity failures
kubectl logs -n egaop deployment/workflow-engine --tail=100 | grep -i "activity.*failed"

# Restart workflow engine
kubectl rollout restart deployment/workflow-engine -n egaop
```

### Database Down

```bash
# Check Postgres pod
kubectl describe pod -n egaop -l app.kubernetes.io/name=postgresql

# Check PVC status
kubectl get pvc -n egaop

# Check disk space
kubectl exec -n egaop statefulset/postgresql-postgresql -- df -h /var/lib/postgresql/data

# Emergency: scale up replicas
kubectl scale statefulset/postgresql-postgresql -n egaop --replicas=3
```

## Escalation

| Severity | Condition | Response Time | Escalation |
|----------|-----------|---------------|------------|
| P0 | All services down | 15 min | Page on-call + engineering lead |
| P1 | Single service down, no workaround | 30 min | Page on-call |
| P2 | Degraded performance | 2 hours | Slack #incidents |
| P3 | Non-impactful issue | Next business day | Jira ticket |

## Post-Incident

1. Create incident report (template in wiki)
2. Update monitoring/alerts if gap found
3. Add runbook step if new failure mode
4. Schedule blameless postmortem for P0/P1
