# Data Layers — Bronze, Silver, Gold

## Bronze Layer (raw, immutable)

**Table**: `raw_document` in Postgres + S3 object in Garage (`mi-raw` bucket)

Each source fetcher lands documents here. Content is never mutated — `ON CONFLICT
(content_hash)` makes re-fetches idempotent. The `raw_document` row carries the
source, sourceRef, and a pointer to the S3 object.

### Bronze columns
```
raw_document
  id              uuid PK
  content_hash    text UNIQUE (sha256 of raw bytes)
  source          text (e.g. 'sec-form-adv', 'irs-990', 'form5500')
  source_ref      text (URL or identifier from the source)
  s3_key          text (path in Garage bucket)
  s3_bucket       text ('mi-raw')
  content_type    text (MIME type)
  document_date   date (when the source published it)
  ingested_at     timestamptz
```

### Bronze checks (Soda DQ)
- `missing_count(content_hash) = 0`
- `duplicate_count(content_hash) = 0`
- `missing_count(source) = 0`

---

## Silver Layer (structured, resolved)

**Tables**: `mandate_event`, `mandate`, `organisation`, `person`, `annotation`, `mandate_party`

The ETL pipeline extracts structure from raw documents (bronze), resolves entities
(organisations, persons), and lands structured mandate events. Silver is append-only.

### Silver tables

```
mandate_event
  id              uuid PK
  mandate_id      uuid FK -> mandate
  source_document_id uuid FK -> raw_document
  allocator_ref   text
  organisation_id uuid FK -> organisation
  asset_class     text
  size_band       text
  stage           text
  region          text
  event_date      date
  facets          text[]
  source          text
  source_ref      text
  confidence      float (0-1)
  embedding       vector(384) (pgvector, for semantic search)
  created_at      timestamptz

mandate
  id              uuid PK
  name            text
  mandate_type    text
  status          text
  organisation_id uuid FK -> organisation
  current_stage   text
  current_stage_at date
  created_at      timestamptz

organisation
  id              uuid PK
  name            text
  normalised_name text UNIQUE
  aliases         organisation_alias[]
  identifiers     organisation_identifier[]
  created_at      timestamptz

person
  id              uuid PK
  name            text
  normalised_name text
  aliases         person_alias[]
  created_at      timestamptz

annotation
  id              uuid PK
  mandate_event_id uuid FK -> mandate_event
  annotator_type  text (human, system, llm)
  field           text
  value           text
  confidence      float
  created_at      timestamptz

mandate_party
  id              uuid PK
  mandate_id      uuid FK -> mandate
  party_type      text (allocator, recipient, intermediary)
  organisation_id uuid FK -> organisation
  person_id       uuid FK -> person
  surface_form    text (the entity name as it appeared in the source document)
  role            text
  created_at      timestamptz
```

### Silver checks (Soda DQ)
- `mandate_event`: `missing_count(source_document_id) = 0`, `missing_count(mandate_id) = 0`, `missing_count(event_date) = 0`, `duplicate_count(id) = 0`
- `mandate_party`: `missing_count(surface_form) = 0`

---

## Gold Layer (insights, derived)

**Derived from**: Silver tables via jobs, scheduled aggregations, and user queries.

### Gold artifacts

| Artifact | Source | Purpose |
|----------|--------|---------|
| Aggregates | mandate_event | Counts by facet dimension (asset_class, region, stage, etc.) |
| Signals | mandate_event + user annotations | Flagged events that need attention |
| Saved searches | User-defined facet + semantic filters | Reusable search queries |
| Dashboard | Aggregates + signals | Visual overview of mandate portfolio |
| Alerts | Scheduled job (run-alerts) | Email/notification on new events matching user-defined criteria |
| CSV export | mandate_event search result | Full dataset export via pagination |
| Similarity search | mandate_event.embedding | Semantic nearest-neighbor search by embedding cosine distance |

### Gold properties
- Derived, not source-of-truth (re-computable from silver)
- Cached in Postgres tables (aggregates) or materialized on demand (CSV)
- Scheduled recomputation via platform jobs

---

## Pipeline Flow

```
External data source
  │
  ▼
Source Fetcher (one per source, 21+ implemented)
  └─ lands raw document → bronze: raw_document table + Garage S3
  │
  ▼
Extraction Pipeline (dispatch → stage chain)
  └─ fetch stage: reads bronze, prepares for extraction
  └─ entity-extraction stage: LLM extracts entities from raw text
  └─ classification stage: categorizes the document
  └─ resolution stage: resolves entities against known orgs/persons
  └─ annotation stage: applies field-level annotations
  └─ embedding stage: computes pgvector embedding
  └─ emit stage: lands structured data → silver: mandate_event
  │
  ▼
Notifications / Scheduling
  └─ run-alerts job: checks for new events matching saved searches
  └─ ingestion-check job: monitors source freshness, alerts on stalls
  └─ Soda DQ CronJob: runs data quality checks on all layers
  │
  ▼
User Interface
  └─ Search (facet + semantic)
  └─ Dashboard (aggregates + signals)
  └─ CSV Export
  └─ Saved searches
```

## Source Catalog (25+ sources)

| Source | Fetcher | Type | Status |
|--------|---------|------|--------|
| SEC Form ADV | sec-form-adv.fetcher.ts | Regulatory filing | ✅ Live |
| SEC NPORT | sec-nport.fetcher.ts | Regulatory filing | ✅ Live |
| SEC 13F | sec-13f.fetcher.ts | Regulatory filing | ✅ Live |
| SEC EFTS | sec-efts.fetcher.ts | Regulatory filing | ✅ Live |
| SEC NCEN | sec-ncen.fetcher.ts | Regulatory filing | ✅ Live |
| IRS Form 990 | irs-990.fetcher.ts | Non-profit filing | ✅ Live |
| Form 5500 (main) | form5500.fetcher.ts | Pension filing | ✅ Live |
| Form 5500 Schedule C | form5500-schedule-c.fetcher.ts | Pension filing | ✅ Live |
| Form 5500 Schedule H | form5500-schedule-h.fetcher.ts | Pension filing | ✅ Live |
| USASpending | usaspending.fetcher.ts | Gov contracts | ✅ Live |
| SAM.gov | sam-gov.fetcher.ts | Gov contracts | 🔒 Blocked (API key) |
| GLEIF LEI | gleif-lei.fetcher.ts | Entity identifiers | ✅ Live |
| GLEIF RR | gleif-rr.fetcher.ts | Entity relationships | ✅ Live |
| MSRB EMMA | msrb-emma.fetcher.ts | Municipal securities | 🔒 Blocked (license) |
| LGPS Annual Report | lgps-annual-report.fetcher.ts | Pension report | ✅ Live |
| Census ASPP | census-aspp.fetcher.ts | Census data | ✅ Live |
| CAFR | cafr.fetcher.ts | Financial reports | ✅ Live |
| Board Minutes | board-minutes.fetcher.ts | Gov meeting notes | ✅ Live |
| RFP Mass PERAC | rfp-mass-perac.fetcher.ts | Mass RFP data | 🔒 Blocked (WAF) |
| UK Contracts Finder | uk-contracts-finder.fetcher.ts | UK gov contracts | ✅ Live (structurer has schema issue) |