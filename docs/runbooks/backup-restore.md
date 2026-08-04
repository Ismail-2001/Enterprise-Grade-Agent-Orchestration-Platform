# Backup & Restore Runbook

## Database Backup

### Manual Backup (PostgreSQL)

```bash
# Backup all databases
kubectl exec -n egaop statefulset/postgresql-postgresql -- \
  pg_dumpall -U postgres > egaop-backup-$(date +%Y%m%d-%H%M%S).sql

# Backup specific database
kubectl exec -n egaop statefulset/postgresql-postgresql -- \
  pg_dump -U postgres egaop > egaop-$(date +%Y%m%d-%H%M%S).sql

# Backup with compression
kubectl exec -n egaop statefulset/postgresql-postgresql -- \
  pg_dump -U postgres egaop | gzip > egaop-$(date +%Y%m%d-%H%M%S).sql.gz
```

### Automated Daily Backup

```bash
# Add CronJob for daily backups
cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: CronJob
metadata:
  name: egaop-backup
  namespace: egaop
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: postgres:16-alpine
            command:
            - /bin/sh
            - -c
            - |
              pg_dump -h postgresql-postgresql -U postgres egaop | gzip > /backup/egaop-\$(date +%Y%m%d).sql.gz
            env:
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgresql-postgresql
                  key: password
            volumeMounts:
            - name: backup-volume
              mountPath: /backup
          volumes:
          - name: backup-volume
            persistentVolumeClaim:
              claimName: egaop-backup-pvc
          restartPolicy: OnFailure
EOF
```

## Restore

### Restore from Backup

```bash
# Restore from SQL file
kubectl exec -i -n egaop statefulset/postgresql-postgresql -- \
  psql -U postgres egaop < egaop-backup-20260805.sql

# Restore from compressed backup
kubectl exec -i -n egaop statefulset/postgresql-postgresql -- \
  bash -c "gunzip | psql -U postgres egaop" < egaop-backup-20260805.sql.gz
```

### Point-in-Time Recovery

```bash
# Enable WAL archiving (if not already)
# In values-production.yaml:
# postgresql.walLevel: replica
# postgresql.archiveMode: true
# postgresql.archiveCommand: 'test ! -f /archive/%f && cp %p /archive/%f'

# Restore to specific timestamp
kubectl exec -i -n egaop statefulset/postgresql-postgresql -- \
  psql -U postgres -c "SELECT pg_create_restore_point('2026-08-05 14:00:00');"
```

## Redis Backup

### Manual Backup

```bash
# Trigger BGSAVE
kubectl exec -n egaop statefulset/redis-master -- redis-cli BGSAVE

# Copy RDB file
kubectl cp egaop/redis-master-0:/data/dump.rdb ./redis-backup-$(date +%Y%m%d).rdb
```

### Restore Redis

```bash
# Stop Redis, copy RDB, restart
kubectl delete pod -n egaop redis-master-0
# RDB will be restored from PVC on restart
```

## Secrets Backup

### Export Kubernetes Secrets

```bash
# Export all E-GAOP secrets
kubectl get secrets -n egaop -o yaml > egaop-secrets-$(date +%Y%m%d).yaml

# Export External Secrets
kubectl get externalsecrets -n egaop -o yaml > egaop-externalsecrets-$(date +%Y%m%d).yaml
```

### Restore Secrets

```bash
kubectl apply -f egaop-secrets-20260805.yaml
kubectl apply -f egaop-externalsecrets-20260805.yaml
```

## Backup Schedule

| Component | Frequency | Retention | Method |
|-----------|-----------|-----------|--------|
| PostgreSQL | Daily 2 AM | 30 days | pg_dump + CronJob |
| Redis | On demand | 7 days | BGSAVE + PVC |
| Kubernetes Secrets | Weekly | 90 days | kubectl export |
| Helm Release | On deploy | All revisions | helm history |

## Disaster Recovery

### RTO/RPO Targets

| Metric | Target |
|--------|--------|
| RPO (Recovery Point Objective) | 24 hours (daily backups) |
| RTO (Recovery Time Objective) | 1 hour |

### Full Restore Procedure

1. Create new namespace: `kubectl create ns egaop-dr`
2. Install Helm chart: `helm install egaop ./charts/e-gaop -n egaop-dr`
3. Restore PostgreSQL: `kubectl exec -i -n egaop-dr ... psql < backup.sql`
4. Restore Redis: copy RDB to new PVC
5. Restore Secrets: `kubectl apply -f secrets.yaml -n egaop-dr`
6. Verify health: `kubectl exec -n egaop-dr deployment/api-server -- curl localhost:15051/healthz`
7. Switch DNS/load balancer to new namespace
