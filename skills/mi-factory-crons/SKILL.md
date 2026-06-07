---
name: mi-factory-crons
description: "All scheduled cron jobs for the Mandate Intelligence platform factory. Each cron is a self-contained prompt ready to install with the `cronjob` tool. Crons cover pipeline health, codebase health, data source monitoring, DLQ watchdog, deploy drift detection, cluster health, and release validation. Load this skill when the user asks to install, inspect, or modify the factory's automated monitoring jobs."
---

# Factory Cron Jobs — Mandate Intelligence

This skill contains every scheduled cron job designed for the Mandate Intelligence
platform. Each is a **self-contained prompt** that you can pass directly to the
`cronjob` tool with `action='create'`.

---

## How to install a cron

```text
cronjob(
  action="create",
  schedule="<schedule-expression>",
  prompt="<the SELF_CONTAINED prompt from below>",
  name="<descriptive-name>",
  skills=["mi-observability"],  // or whichever skill the cron needs
)
```

Each cron below has its `schedule`, `prompt`, and `skills` ready to copy.

---

## Cron: `pipeline-run-health`

Checks for stale pipeline runs every 15 minutes. Surfaces partial/running runs that
have exceeded their time window.

**Why**: Pipeline runs can get stuck in `partial` state indefinitely. Early detection
means faster recovery.

**Schedule**: `every 15m`

**Skills**: `["mi-observability"]`

**Prompt** (self-contained):

```
You are the Pipeline Health Monitor for the Mandate Intelligence platform.
Check the production database for stale pipeline runs.

Run these SQL queries and report:
1. pipeline_runs stuck in 'partial' for > 1 hour
2. pipeline_runs stuck in 'running' for > 4 hours
3. Total pipeline_run count by status (ok, partial, running, abandoned)

Connect via the platform's DB client: DATABASE_URL from the env.

Report format:
PIPELINE HEALTH — <date>
- Stale partial (>1h): <count> — oldest: <id> (<age>)
- Stale running (>4h): <count> — oldest: <id> (<age>)
- Status breakdown: ok=<n> partial=<n> running=<n> abandoned=<n>
- Recommendation: <resume/ignore/investigate>

If count > 0 for stale partial, suggest: bun run job resume <id>
```

---

## Cron: `codebase-health-daily`

Runs the full quality gate on the latest code every morning.

**Why**: Catches drift early — a green `bun run check` is the project's primary
quality invariant.

**Schedule**: `0 9 * * 1-5` (weekdays at 9am)

**Skills**: `["mi-tech-lead"]`

**Prompt** (self-contained):

```
You are the Codebase Health Monitor for the Mandate Intelligence project.
Run the complete quality gate at the repo root.

Commands:
cd /Users/boyan.balev/projects/mandateIntelligence
bun run check

Report format:
CODEBASE HEALTH — <date> — <commit-short>
- typecheck: <PASS/FAIL>
- lint: <PASS/FAIL>
- format:check: <PASS/FAIL>
- test: <PASS/FAIL> (<count> tests)
- verdict: <GREEN/RED>

If RED, list what failed and link to the relevant section of AGENTS.md for diagnostics.

Also check if bun run build succeeds (all 3 apps: api, web, platform).
```

---

## Cron: `data-source-monitor`

Daily check on data source freshness. Warns when sources haven't been ingested recently.

**Why**: 25+ external data sources need to be fetched on cadence. A silent fetch failure
means stale data in the product.

**Schedule**: `0 8 * * *` (daily at 8am)

**Skills**: `["mi-product-steward"]`

**Prompt** (self-contained):

```
You are the Data Source Monitor for the Mandate Intelligence platform.
Check when each source last successfully landed a raw document.

Run SQL:
SELECT source, max(ingested_at) as last_ingested,
       NOW() - max(ingested_at) as days_since
FROM raw_document
GROUP BY source
ORDER BY last_ingested ASC NULLS FIRST;

Known sources and their expected cadence:
- sec-form-adv: daily during filing season, weekly otherwise
- sec-nport: monthly
- sec-13f: quarterly
- form5500 family: annually (form5500DefaultPlanYear = current - 2)
- gleif-lei: daily
- gleif-rr: daily
- usaspending: daily
- irs-990: annually
- lgps-annual-report: annually
- census-aspp: periodically
- cafr: annually
- board-minutes: periodically
- uk-contracts-finder: daily

Any source with no rows ever (NULL last_ingested) is a concern.
Any source not ingested in > 7 * expected_interval is stale.

Report format:
SOURCE FRESHNESS — <date>
- Never fetched: <sources>
- Stale (>7x cadence): <sources with days>
- Healthy: <sources>
- Total distinct sources: <count>
```

---

## Cron: `dlq-watchdog`

Every 30 minutes, checks the NATS DLQ and pipeline_dlq table for growing or aging messages.

**Why**: DLQ accumulation means production issues that need operator attention. A growing
DLQ with no consumers means envelopes are failing silently.

**Schedule**: `every 30m`

**Skills**: `["mi-observability"]`

**Prompt** (self-contained):

```
You are the DLQ Watchdog for the Mandate Intelligence platform.
Check both the NATS JetStream DLQ stream and the pipeline_dlq Postgres table.

For NATS DLQ (requires kubectl):
1. kubectl -n mi-platform exec -it mi-platform-nats-0 -- nats stream info PIPELINE_DLQ
2. kubectl -n mi-platform exec -it mi-platform-nats-0 -- nats stream subjects PIPELINE_DLQ

For pipeline_dlq table (SQL):
SELECT subject, stage, reason, status, count(*) as count
FROM pipeline_dlq
WHERE status = 'parked'
GROUP BY subject, stage, reason, status
ORDER BY count DESC
LIMIT 10;

Also check aging:
SELECT count(*) as aged_14d
FROM pipeline_dlq
WHERE status = 'parked' AND created_at < NOW() - INTERVAL '14 days';

Report format:
DLQ WATCHDOG — <date>
- NATS stream messages: <count>
- NATS DLQ subjects: <subjects>
- Postgres parked rows: <count> (aged >14d: <n>)
- Top reasons: <reason 1> (<n>), <reason 2> (<n>)
- Status: <NORMAL/GROWING/AGING>

If growing or aging, suggest: run dlq-replay for the affected stage, or investigate R-blocked-sources.
```

---

## Cron: `deploy-drift-check`

Hourly comparison between the deployed image SHA and the expected SHA in values-image.yaml.

**Why**: R-deploy-drift is an open high-severity risk. The cluster has been running
stale images. This cron catches drift before it causes data issues.

**Schedule**: `every 1h`

**Skills**: `["mi-release-engineer"]`

**Prompt** (self-contained):

```
You are the Deploy Drift Detector for the Mandate Intelligence platform.
Check if the deployed images match what's in values-image.yaml.

Expected sha from values-image.yaml:
cat /Users/boyan.balev/projects/mandateIntelligence/infra/k3s/charts/mi-platform/values-image.yaml

Deployed sha (requires kubectl with the hetzner KUBECONFIG):
export KUBECONFIG="$HOME/.kube/hetzner"
kubectl -n mi-platform get deploy mi-platform-api -o jsonpath='{.spec.template.spec.containers[0].image}'
kubectl -n mi-platform get deploy mi-platform-web -o jsonpath='{.spec.template.spec.containers[0].image}'

Also check deployment status:
kubectl -n mi-platform rollout status deploy/mi-platform-api --timeout=10s 2>/dev/null; echo "---"
kubectl -n mi-platform rollout status deploy/mi-platform-web --timeout=10s 2>/dev/null; echo "---"

Report format:
DEPLOY DRIFT CHECK — <date>
- expected sha: <sha from values-image.yaml>
- api deployed: <sha> (<match/drift>)
- web deployed: <sha> (<match/drift>)
- api rollout: <Ready/not ready>
- web rollout: <Ready/not ready>
- verdict: <OK/DRIFT>

If drift detected, the R-deploy-drift risk is still open. Recommend running:
helm upgrade --install mi-platform ... deploy command from infra/k3s/README.md
```

---

## Cron: `cluster-health`

Every 5 minutes, verify all critical services are responding.

**Why**: Early detection of pod crashes, DB connection issues, or service downtime
before users notice.

**Schedule**: `every 5m`

**Skills**: `["mi-observability"]`

**Prompt** (self-contained):

```
You are the Cluster Health Monitor for the Mandate Intelligence platform.
Check that all critical services are running and healthy.

Requires kubectl with hetzner KUBECONFIG:
export KUBECONFIG="$HOME/.kube/hetzner"

Check 1 — Pod status:
kubectl -n mi-platform get pods --no-headers | awk '{print $1, $3}'

Check 2 — API health endpoint:
curl -sf https://mandateintelligence.boyanbalevengineering.com/api/health 2>&1 || echo "FAIL"

Check 3 — API DB health:
curl -sf https://mandateintelligence.boyanbalevengineering.com/api/health/db 2>&1 || echo "FAIL"

Check 4 — Web returns 200:
curl -sf -o /dev/null -w "%{http_code}" https://mandateintelligence.boyanbalevengineering.com/ 2>&1 || echo "FAIL"

Report format:
CLUSTER HEALTH — <date>
- API: <Running/CrashLoop/ImagePullBackOff/...> — health: <200/fail> — db: <200/fail>
- Web: <Running/CrashLoop/...> — http: <200/fail>
- NATS: <Running/CrashLoop/...>
- Garage: <Running/CrashLoop/...>
- Marquez: <Running/CrashLoop/...>
- Grafana: <Running/CrashLoop/...> (if observability enabled)
- Total pods: <count>
- Unhealthy pods: <count>
- verdict: <HEALTHY/UNHEALTHY>

If any service is unhealthy, list the affected pods and suggest running:
kubectl -n mi-platform describe pod <unhealthy-pod>
kubectl -n mi-platform logs <unhealthy-pod> --tail=100
```

---

## Cron: `convention-compliance`

Weekly scan for abstraction creep and rule-of-3 violations across the codebase.

**Why**: The number-one risk in agent-built repos is speculative abstraction. A weekly
scan catches it before it calcifies.

**Schedule**: `0 9 * * 1` (Mondays at 9am)

**Skills**: `["mi-tech-lead"]`

**Prompt** (self-contained):

```
You are the Convention Compliance Scanner for the Mandate Intelligence project.
Scan the codebase for architecture drift.

Check 1 — Rule of 3 violations: find any generic/base/interface used in fewer than 3 call sites.
grep -r "BaseRepository\|BaseService\|Abstract\|Generic\|createCrud" apps/ packages/
  -- Look for generics, base classes, abstract patterns

Check 2 — Abstraction smell: find any "utils", "helpers", "types" files outside common/
find apps packages -name "*utils*" -o -name "*helpers*" -o -name "*types*" | grep -v node_modules | grep -v "common/"

Check 3 — Cross-domain imports: verify no domain A repository imports domain B
search for patterns like '../../<domain>' in repository files

Check 4 — Convention drift from GROUNDING.md:
Check apps platform LOC counts against the reference GROUNDING.md module graph
find apps -name "*.ts" | xargs wc -l | tail -1

Report format:
CONVENTION COMPLIANCE — <date>
- Rule of 3 violations: <count (details if any)>
- Utils/Helpers/Types outside common/: <files>
- Cross-domain repo imports: <count>
- Platform LOC drift from GROUNDING.md: <expected/actual>
- Status: <CLEAN/VIOLATIONS_FOUND>

If violations found, list each with the file path and a fix recommendation.
```

---

## Cron: `release-validate`

After every release merge, verify the deploy succeeded.

**Why**: Catches deploy failures immediately after a merge, while the operator is still
warm. Avoids the "I'll check later" trap.

**Schedule**: This is event-triggered, not recurring. Manually run after each merge.
But can also run as a periodic check every 15 minutes.

**Skills**: `["mi-release-engineer"]`

**Prompt** (self-contained):

```
You are the Release Validator for the Mandate Intelligence platform.
Verify that the latest release is fully deployed and healthy.

Requires kubectl with the hetzner KUBECONFIG:
export KUBECONFIG="$HOME/.kube/hetzner"

Check 1 — Git state on main:
cd /Users/boyan.balev/projects/mandateIntelligence
git log -1 --oneline

Check 2 — Deployed image vs git HEAD:
git rev-parse HEAD
kubectl -n mi-platform get deploy mi-platform-api -o jsonpath='{.spec.template.spec.containers[0].image}'
kubectl -n mi-platform get deploy mi-platform-web -o jsonpath='{.spec.template.spec.containers[0].image}'

Check 3 — Rollout status:
kubectl -n mi-platform rollout status deploy/mi-platform-api --timeout=30s
kubectl -n mi-platform rollout status deploy/mi-platform-web --timeout=30s

Check 4 — Health:
curl -fsS https://mandateintelligence.boyanbalevengineering.com/api/health
curl -fsS https://mandateintelligence.boyanbalevengineering.com/api/health/db

Report format:
RELEASE VALIDATION — <date> — <git-sha>
- Deployed api sha: <sha> — <matches HEAD / mismatch>
- Deployed web sha: <sha> — <matches HEAD / mismatch>
- api rollout: <ready/not ready>
- web rollout: <ready/not ready>
- api health: <200/fail>
- db health: <200/fail>
- verdict: <OK/ROLLBACK_NEEDED>

If anything is wrong, suggest rolling back: helm rollback mi-platform -n mi-platform <revision>
```

---

## Cron: `slice-boundary-check`

Weekly scan to verify no slice writes outside its owned paths.

**Why**: Slice isolation is the galaxy's primary structural invariant. Uncontrolled
cross-slice writes cause merge conflicts and context leaks.

**Schedule**: `0 10 * * 1` (Mondays at 10am)

**Skills**: `["mi-tech-lead"]`

**Prompt** (self-contained):

```
You are the Slice Boundary Scanner for the Mandate Intelligence project.
Verify that recent changes respect the slice boundaries defined in .galaxy/state.json.

Read the current slice definitions from:
cat /Users/boyan.balev/projects/mandateIntelligence/.galaxy/state.json | python3 -c "import json,sys; d=json.load(sys.stdin); [print(s['id'], s['paths']) for s in d['partition']['slices']]"

Then check the last commit's diff:
cd /Users/boyan.balev/projects/mandateIntelligence
git log -1 --name-only --format="%H %s"

Check if any commit changes cross slice boundaries:
- A file in path A should only be modified by slices that own path A
- If a seam changed, it should only be the seam owner's commit

Report format:
SLICE BOUNDARY CHECK — <date>
- Last commit: <sha> — <subject>
- Files changed: <count>
- Boundary violations: <count>
- Details: <if violations, list file and which slice wrote it>
- Status: <CLEAN/VIOLATION>

If violations found, flag them for the next galaxy run's triage phase.
```

---

## Summary Table

| Cron | Schedule | Checks | Skills |
|------|----------|--------|--------|
| pipeline-run-health | every 15m | Stale pipeline runs | mi-observability |
| codebase-health-daily | weekdays 9am | Quality gate (typecheck, lint, format, test) | mi-tech-lead |
| data-source-monitor | daily 8am | Source freshness, last ingestion | mi-product-steward |
| dlq-watchdog | every 30m | NATS DLQ + pipeline_dlq table | mi-observability |
| deploy-drift-check | every 1h | Deployed SHA vs values-image.yaml | mi-release-engineer |
| cluster-health | every 5m | All pod health + endpoint checks | mi-observability |
| convention-compliance | weekly Mon 9am | Rule of 3, utils/helpers/files, cross-domain imports | mi-tech-lead |
| slice-boundary-check | weekly Mon 10am | Slice paths vs actual file changes | mi-tech-lead |
| release-validate | on-demand after merge | Deployed SHA, rollout, health endpoints | mi-release-engineer |