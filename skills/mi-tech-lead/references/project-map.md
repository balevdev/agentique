# Project Map — Mandate Intelligence

## Workspace dependency tree

```
@mi/api (apps/api)        Hono HTTP API       ~6.1k LOC
  depends on: contracts, db, core

@mi/platform (apps/platform)  Bun job runner  ~27k LOC
  depends on: contracts, db, lakehouse, pipeline-bus, core

@mi/web (apps/web)         TanStack Start FE   ~3.8k LOC
  depends on: contracts, design, config

@mi/contracts (packages/contracts)  Zod schemas ~0.7k LOC
  depends on: zod

@mi/core (packages/core)   Leaf primitives     ~0.6k LOC
  depends on: none

@mi/db (packages/db)       Drizzle schema      ~0.9k LOC
  depends on: core

@mi/design (packages/design)  Design system     ~1.8k LOC
  depends on: react, base-ui

@mi/lakehouse (packages/lakehouse)  S3 abstraction  ~0.6k LOC
  depends on: aws-sdk, core

@mi/pipeline-bus (packages/pipeline-bus)  NATS pub/sub  ~0.7k LOC
  depends on: nats, core, zod

@mi/config (packages/config)  Env validation   ~0.2k LOC
  depends on: zod
```

## Repository layout

```
mandateIntelligence/
  apps/
    api/            Hono HTTP surface (mandate-event search, aggregates, auth, dashboard)
    web/            TanStack Start frontend (serving web app)
    platform/       Bun job runner (ingestion, extraction, entity resolution, alerting)
  packages/
    db/             Drizzle schema + migrations + test harness (withTestDb)
    core/           Domain-agnostic primitives (logger, errors, id, hash, embedding)
    config/         Env loaders (loadEnv, loadApiEnv, loadWorkerEnv)
    design/         Design tokens + Base UI component library
    contracts/      Shared zod IO schemas (FE and BE both import)
    lakehouse/      S3 abstraction (Garage-backed)
    pipeline-bus/   NATS JetStream pub/sub with typed topics
  infra/
    docker/         Dockerfiles (api, web, platform)
    k3s/            Helm charts, ArgoCD bootstrap, observability
    data-quality/   Soda DQ checks (bronze, silver, gold)
    scheduling/     Kestra workflow definitions
    runbook.md      On-call ops cookbook
```

## Apps/API domain structure (13 domains)

```
apps/api/src/domains/
  annotation/     model, repository, service, router, test
  auth/           model, repository, service, router, validation, test
  dashboard/      repository, service, router, test
  health/         service, router, test
  mandate/        repository, service, router, test
  mandate-event/  model, repository, service, router, csv, test
  organisation/   repository, service, router, test
  pipeline/       repository, service, router, test
  raw-document/   repository, service, router, test
  saved-search/   model, repository, service, router, test
  signal/         repository, service, router, test (annotations)
  aggregates/     repository, router, service, test
```

## Apps/Platform domain structure (11 domains + ETL)

```
apps/platform/src/domains/
  alert/          model, repository, service, job, test
  annotation/     model, repository, service, job, test
  ingestion-run/  model, repository, service, job, test
  mandate/        model, repository, service
  mandate-event/  model, repository, service, job (reprocess), test
  organisation/   model, repository, service, job (er-eval)
  person/         model, repository, service
  pipeline-dlq/   model, repository, service, job (dlq-replay)
  pipeline-run/   model, repository, service
  raw-document/   model, repository, service
  saved-search/   model, repository, service

apps/platform/src/etl/
  stages/         fetch, entity-extraction, classification, resolution, annotation, embedding, emit
  structurers/    One per source (21+ structurers)
  jobs/           dispatch, extract, fetch-source (KNOWNSOURCES), resume, seed, structure-reference, structuring-eval, llm-structuring-eval
  eval-cases/     Evaluation data for structurer quality
  references/     Reference data for entity resolution
```

## API middleware stack (in order)

1. `request-id` — adds X-Request-Id to every request
2. `csrf` — CSRF protection for session-based auth
3. `auth` — Session validation, user lookup
4. `error-handler` — Maps thrown errors to HTTP responses
5. `rate-limit` — In-memory rate limiting per IP
6. `query` — Parses common query params (limit, cursor)

## Error types (closed set in @mi/core)

- `NotFoundError` → 404
- `ValidationError` → 400
- `ConflictError` → 409
- `DependencyError` → 502
- `UnauthorizedError` → 401