# Run History — All 7 Galaxy Runs

## Run 1: 2026-06-06-code-smell-sweep
- **Mode**: review
- **Spec**: Code smell audit — clean up shared helper duplication, test fixture patterns
- **Slices**: S1-seam-helpers, S2-structurer-migration, S3-fetcher-migration, S4-api-test-fixtures
- **Gate**: green
- **Key outputs**: First 3 frozen conventions (C1-C3), 3 active decisions (D1-D3)

## Run 2: 2026-06-06-live-cluster-e2e
- **Mode**: review
- **Spec**: Live cluster end-to-end verification — deploy flow, NATS connectivity, bronze/silver/gold pipeline
- **Slices**: S1-deploy-seam, S2-fetcher-live-verification, S3-local-e2e, S4-cluster-rollout, S5-dispatch-loop
- **Gate**: green
- **Bounces**: 3 bounces on S2-fetcher-live-verification (mid-flight typecheck noise)
- **Key outputs**: R-llm-key (opened), R-blocked-sources (opened), Live cluster deployment verified

## Run 3: 2026-06-06-code-alignment-sweep
- **Mode**: review
- **Spec**: Code alignment sweep — fix all sources to match conventions
- **Slices**: S0-seam-config, S1-fetchers-regulatory, S2-fetchers-owners, S3-structurers, S4-orchestration, S5-infra
- **Gate**: green
- **Bounces**: 1 bounce on S2-fetchers-owners (single-use export-for-test)
- **Key outputs**: C3 (shipped default catalogues stay private), R-f5500-year-default (opened)

## Run 4: 2026-06-06-deterministic-mandate-spine
- **Mode**: build
- **Spec**: Build deterministic mandate spine — form5500 year alignment, spine structurers, blocked source ergonomics
- **Slices**: S1-family-year, S2-spine-structurers, S3-blocked-ergonomics
- **Gate**: green
- **Key outputs**: D4 (shared form5500DefaultPlanYear), R-f5500-year-default (closed), R-join-ackid-overlap (opened)

## Run 5: 2026-06-06-maintenance-simplicity-sweep
- **Mode**: review
- **Spec**: Behavior-preserving simplicity sweep across the entire codebase
- **Slices**: S7-api-packages, S1-fetchers-regulatory, S2-fetchers-owners, S3-fetchers-blocked, S4-structurers-stages, S5-orchestration, S6-platform-domains, S8-web, S9-infra-scripts
- **Gate**: green
- **Key outputs**: C4 (module-private constants stay un-exported), R-zip-decode-dup (opened), R-stage-cast (opened), R-api-limit-pattern (opened), R-web-clsx-dep (opened)

## Run 6: 2026-06-06-dlq-persistence-replay
- **Mode**: build
- **Spec**: DLQ persistence + replay — park dead-lettered envelopes in Postgres, operator panel, replay job
- **Slices**: S1-DLQ-SEAM, S2-DLQ-PLATFORM, S3-DLQ-API, S4-DLQ-WEB, S5-DLQ-DQ
- **Gate**: green
- **Key outputs**: D-dlq-deterministic-id, D-dlq-no-auto-replay, C5 (PipelineBus interface update rule), pipeline_dlq table, dlq-replay job

## Run 7: 2026-06-07-etl-promotion-system-eval
- **Mode**: build
- **Spec**: ETL promotion to src/etl/, OpenRouter provider seam, DE+PM evaluation, repo-wide audit fixes, live cluster validation
- **Slices**: S1-etl-seam, S2-llm-provider, S3-eval-de-pm, S4-api-web-packages, S5-fetchers, S6-cluster-live, S7-platform-domains, S8-etl-internals
- **Gate**: residual (with logged risks)
- **Bounces**: 2 on S1-etl-seam (logic edits in moved files, LOC count drift), 1 on S7-platform-domains (ESLint errors on own test files)
- **Key outputs**: D-etl-top-level, D-llm-provider-pluggable, OpenRouter client, C6 (ZIP/TSV decode helpers unified at shared.ts)
- **Current open risks**: R-deploy-drift (high), R-lineage-worker-path (medium), R-uk-contracts-structurer-schema (medium), R-llm-key-provision (medium)

## Current slice state (from state.json)

| Slice ID | Class | Seam/Owner |
|----------|-------|------------|
| S1-etl-seam | seam | S1 |
| S2-llm-adapter | seam | S2 |
| S4-api-packages | api | S4 |
| S5-fetchers | etl-fetcher | S5 |
| S7-platform-domains | etl-orchestration | S7 |
| S8-etl-internals | etl-structurer | S8 |
| S9-web | ui | S9 |
| S10-infra-scripts | ops | S10 |

## Open risks (must be triaged every run)

| Risk ID | Severity | Description | Status |
|---------|----------|-------------|--------|
| R-deploy-drift | high | Cluster runs old image; pipeline_dlq migration undeployed; stale pipe_runs pass green | open |
| R-lineage-worker-path | medium | Workers bypass orchestator lineage emission; Marquez unfed | open |
| R-uk-contracts-structurer-schema | medium | Structurer Zod shape rejects real OCDS records | open |
| R-llm-key-provision | medium | No real LLM key in Doppler; gold stays empty | open |
| R-blocked-sources | medium | sam-gov, msrb-emma, rfp-mass-perac cannot ingest (external blockers) | open |
| R-stage-cast | low | `as Stage<never, unknown>` casts in extraction.workers.ts | open |