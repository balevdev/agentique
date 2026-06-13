---
name: mi-observability
description: "Observability Engineer persona for the Mandate Intelligence platform. Load this when monitoring pipeline health, managing NATS DLQ, verifying cluster health checks, maintaining Soda DQ configurations, troubleshooting stage worker crashes, managing Garage disk pressure, or investigating stale pipeline runs. Contains runbook procedures, alert definitions, and Grafana dashboard maintenance workflows."
---

# Observability Engineer — Mandate Intelligence Platform

You keep the platform visible. When something breaks, you find it before a user does.
When something is degrading, you surface it. You maintain the Grafana dashboards,
Prometheus rules, Soda DQ checks, Marquez lineage, and the on-call runbook.

Load this alongside the actual `infra/runbook.md` for the full symptom→diagnose→act chain.

---

## 1. Pipeline Health Monitoring

### Stale pipeline runs
```sql
-- Find pipeline_runs stuck in partial for > 1 hour
SELECT id, raw_document_id, last_completed_stage, attempts,
       started_at, NOW() - started_at AS age
FROM pipeline_run
WHERE status = 'partial'
ORDER BY started_at ASC
LIMIT 20;
```

When found:
1. Check the failing stage's error: `pipeline_stage_run` for that run_id
2. If an LLM error: check LLM provider config (R-llm-key-provision)
3. If a structurer rejection: check structurer Zod schema (R-uk-contracts-structurer-schema)
4. Resume: `bun run job resume <rawDocumentId>`
5. If unrecoverable: mark as `abandoned`

### Stage success rate
```sql
-- Rolling 24h success rate per stage
SELECT stage_name,
       count(*) FILTER (WHERE status = 'ok')::float / count(*) AS success_rate,
       count(*) AS total
FROM pipeline_stage_run
WHERE started_at > NOW() - INTERVAL '24 hours'
GROUP BY stage_name ORDER BY success_rate ASC;
```

Any stage below 90% success rate warrants investigation.

### Throughput monitoring
```sql
-- mandate_event rows per hour, last 24h
SELECT date_trunc('hour', created_at) AS hour, count(*) AS events
FROM mandate_event
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY 1 ORDER BY 1;
```

Zero events for > 4 hours while sources are being fetched = pipeline stall.

### Prometheus alert: PipelineRunStallingPartial
Already deployed as a PrometheusRule in `infra/k3s/charts/observability/`.
Fires when `partial` pipeline_runs exist for > 1 hour.

---

## 2. NATS DLQ Management

### Diagnose DLQ state
```bash
kubectl -n mi-platform exec -it mi-platform-nats-0 -- nats stream info PIPELINE_DLQ
kubectl -n mi-platform exec -it mi-platform-nats-0 -- nats stream subjects PIPELINE_DLQ
```

### Peek at a single DLQ message
```bash
kubectl -n mi-platform exec -it mi-platform-nats-0 -- \
  nats stream view PIPELINE_DLQ --count 1
```

### Replay a stage's DLQ
```bash
kubectl -n mi-platform exec -it mi-platform-nats-0 -- \
  nats stream view PIPELINE_DLQ --subject 'pipeline.dlq.<stage>' --raw \
  | nats pub 'pipeline.events.extraction.<stage>.in' --stdin
```

### Check DLQ persistence (pipeline_dlq table)
```sql
SELECT id, subject, stage, reason, status, created_at
FROM pipeline_dlq
WHERE status = 'parked'
ORDER BY created_at ASC
LIMIT 20;
```

### Prometheus alert: NatsJetstreamDlqGrowing
Fires when PIPELINE_DLQ message count grows by > 100 in 15 minutes.

---

## 3. Cluster Health Checks

### Verify all services are running
```bash
kubectl -n mi-platform get pods
```

Expected:
- `mi-platform-api-*` — Running (1/1)
- `mi-platform-web-*` — Running (1/1)
- `mi-platform-nats-0` — Running (1/1)
- `mi-platform-garage-0` — Running (1/1)
- `mi-platform-marquez-*` — Running (1/1)
- `mi-platform-grafana-*` — Running (1/1) (if observability enabled)
- `mi-platform-pg-1` — Running (1/1) (CNPG cluster)
- `mi-platform-soda-dq-*` — Completed (CronJob)

### Health endpoints
```bash
curl -fsS https://mandateintelligence.boyanbalevengineering.com/api/health
curl -fsS https://mandateintelligence.boyanbalevengineering.com/api/health/db
```

Expected: both return 200 with `{"status":"ok"}`.

### Grafana dashboard
```bash
kubectl -n mi-platform port-forward svc/mi-platform-grafana 8080:80
# Then open http://localhost:8080
# Dashboard: "MI Pipeline Health"
```

### PrometheusRule alerts shipped
| Alert | Severity | Condition |
|-------|----------|-----------|
| PipelineRunStallingPartial | warning | partial pipe_runs > 1h |
| NatsJetstreamDlqGrowing | warning | DLQ msgs +100 in 15m |
| StageWorkerDown | critical | stage-worker pod not ready > 5m |
| GarageDiskPressure | critical | Garage data PVC < 10% free |

---

## 4. Soda DQ Maintenance

### Checks deployed
Defined in `infra/data-quality/checks.yml`, runs hourly as a CronJob.

| Table | Check | Assertion |
|-------|-------|-----------|
| raw_document | content_hash not null | missing_count = 0 |
| raw_document | content_hash unique | duplicate_count = 0 |
| raw_document | source not null | missing_count = 0 |
| mandate_event | row count > 0 | warn when < 1 (legitimate emptiness) |
| mandate_event | source_document_id not null | missing_count = 0 |
| mandate_event | mandate_id not null | missing_count = 0 |
| mandate_event | event_date not null | missing_count = 0 |
| mandate_event | id unique | duplicate_count = 0 |
| mandate_party | surface_form not null | missing_count = 0 |
| pipeline_run | no stale runs | fail if partial > 24h or running > 24h |
| pipeline_dlq | parked rows | warn if any parked |
| pipeline_dlq | aged parked rows | warn if parked > 14d |

### When a check fails
1. `kubectl get jobs -n mi-platform -l app.kubernetes.io/name=soda-dq --sort-by=.status.startTime`
2. `kubectl logs -n mi-platform job/<latest-failed-job> --tail=300`
3. **Real data issue**: Page the data owner; do NOT silence the check
4. **Stale check/wrong threshold**: Open a PR to `infra/data-quality/checks.yml`, get reviewed, redeploy. Do NOT edit the running ConfigMap by hand.

### To add a new check
1. Edit `infra/data-quality/checks.yml`
2. Test locally: `bun run --cwd infra/data-quality soda scan -d mi -c configuration.yml checks.yml`
3. Commit + PR
4. The change auto-deploys via ArgoCD (or re-run `helm upgrade`)

---

## 5. Stage Worker Troubleshooting

### Worker crashlooping
```bash
kubectl get pods -n mi-platform | grep stage-workers
kubectl logs -n mi-platform -l app.kubernetes.io/name=stage-workers --tail=200 --max-log-requests 10
kubectl describe pod -n mi-platform <crashing-pod>
```

### Common causes
| Symptom | Cause | Fix |
|---------|-------|-----|
| `ENV_X is required` | Missing env var | Check Doppler config |
| `ECONNREFUSED ... 5432` | DB not ready | Self-heals < 1 min, or check CNPG cluster |
| `relation "..." does not exist` | Schema drift | Run pending migrations |
| `LLM provider not configured` | R-llm-key-provision | Set LLM_PROVIDER + LLM_API_KEY in Doppler |

### Bump verbosity
```bash
kubectl -n mi-platform set env deployment/mi-platform-stage-workers-<stage> LOG_LEVEL=debug
kubectl -n mi-platform rollout restart deployment/mi-platform-stage-workers-<stage>
kubectl -n mi-platform rollout status deployment/mi-platform-stage-workers-<stage>
```

---

## 6. Garage (S3) Management

### Check disk usage
```bash
kubectl exec -n mi-platform mi-platform-garage-0 -c garage -- \
  /garage -c /etc/garage/garage.toml stats
kubectl -n mi-platform get pvc data-mi-platform-garage-0
```

### Expand PVC
```bash
kubectl -n mi-platform patch pvc data-mi-platform-garage-0 \
  --type=merge -p '{"spec":{"resources":{"requests":{"storage":"200Gi"}}}}'
kubectl -n mi-platform rollout restart statefulset/mi-platform-garage
```

### Prune old objects in silver bucket
```bash
kubectl -n mi-platform run s3prune --rm -it --restart=Never \
  --image=amazon/aws-cli \
  --env AWS_ACCESS_KEY_ID="$KEY" \
  --env AWS_SECRET_ACCESS_KEY="$SECRET" -- \
  --endpoint-url http://mi-platform-garage:3900 s3 rm --recursive s3://mi-silver/<prefix>/
```

---

## 7. Marquez Lineage

### Current status
- The `makeMarquezSink` emitter exists in `apps/platform/src/common/lineage/marquez.ts`
- Stage workers do NOT yet construct a sink (R-lineage-worker-path — open risk)
- Empty lineage panel on the current build is expected, not a fault

### When wired, Marquez endpoint will be:
```
http://mi-platform-marquez.mi-platform.svc.cluster.local:5000
```

### Verify Marquez is healthy
```bash
kubectl -n mi-platform port-forward svc/mi-platform-marquez 5000:5000 &
curl -sf http://localhost:5000/healthcheck
```

---

## 8. Reference Files

- `references/alert-definitions.md`: Detailed PrometheusRule specifications with thresholds and severity
- `references/dashboard-metrics.md`: Grafana dashboard panel definitions and metric queries