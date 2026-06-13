# Memory: the .galaxy/ layout and schemas

The factory's memory is a typed artifact filesystem, not anyone's context window. Agents
are disposable; the state is durable. Three machine files owned by the CLI, three prose
files owned by the session, one directory per run.

| File | Writer | Role |
|------|--------|------|
| `state.json` | CLI only | stamps, proven partition, risks, pending triage, ratchet grants |
| `LEDGER.jsonl` | CLI only | append-only run records and bounce records |
| `runs/<id>/` | session | SPEC.md, DESIGN.md, SLICES.md, contracts/, reports/, SUMMARY.md, run-report.json |
| `GROUNDING.md` | session | stable layer: glossary, module graph, seams, conventions |
| `DECISIONS.md` | CLI appends | ADR log; entries are active or superseded by a later entry |
| `CONVENTIONS.md` | CLI appends | frozen conventions with origin run |

Never hand-edit the machine files. If state is wrong, fix it through a run (a risk, a
disposition, a stamp in the next report) so the correction is itself recorded.

## The run-report schema (input to `galaxy persist`)

```json
{
  "run": {
    "id": "2026-06-05-saved-search",
    "mode": "build",
    "spec": "one-line spec or path to SPEC.md",
    "commitRange": "abc1234..def5678",
    "gate": "green"
  },
  "slices": [
    {
      "id": "S2-API", "class": "api", "owner": "owner-agent",
      "verdict": "accept",
      "bounces": [{ "ac": "AC3", "reason": "hollow test" }]
    }
  ],
  "risks": {
    "new": [{ "id": "R7", "desc": "perf suite flaky on CI", "owner": "boyan", "severity": "medium" }],
    "dispositions": [{ "riskId": "R5", "action": "close", "reason": "fixed by S2-API" }]
  },
  "decisions": [
    { "id": "D4", "title": "NATS over Kafka", "body": "why", "supersedes": "D2" }
  ],
  "conventions": [
    { "id": "C3", "rule": "errors via errMessage helper, never inline String(e)" }
  ],
  "stamps": {
    "grounding": { "commit": "def5678", "watch": ["src/", "package.json"] },
    "partition": {
      "commit": "def5678",
      "slices": [{ "id": "S2-API", "class": "api", "paths": ["apps/api/"] }]
    }
  }
}
```

Field semantics:

- `gate`: `green` (two-sided check passed), `residual` (passed with logged risks),
  `failed`. Non-green gates break ratchet streaks for every class in the run.
- `slices[].class`: free-form slice classification (api, ui, infra, seam, security,
  migration, ...). The ratchet and bounce statistics are keyed on it; classify
  consistently. Bounces recorded here are the verifier bounces that happened during the
  run, even if later fixed; they are the factory's defect ledger.
- `risks.dispositions[].action`: exactly one of `finding`, `defer`, `close` (same closed
  set as the `galaxy triage` argument). Dispositions may also come from `galaxy triage`
  commands during the run; the report wins on conflict. `finding` and `close` close the
  risk (`finding` means it became contract scope this run; if the work bounced, record a
  new risk). `defer` keeps it open with a recorded reason and requires re-triage next run.
- `decisions`: only decisions that survived the gate. A superseding decision must name an
  existing decision id or persist refuses.
- `stamps`: include ONLY layers actually refreshed this run. Omitting `stamps` never
  un-stamps anything; persist without it leaves staleness exactly as it was.

## Invariants: a convention or AC with a mechanical check

A local change can be correct in its own module and still collapse a distinction the whole
system depends on (a point silently treated as an interval, money silently turned into a
float). An invariant is that distinction, written so a verifier can fail it without
judgment. It is not a new file or a schema field; it is a tag plus two lines on an ordinary
convention or acceptance criterion:

```
[INVARIANT] <one-line name>
Distinction: the semantic point in one sentence (a point is not an interval).
Check: exactly one mechanical enforcement: a test path, a lint/fallow rule, or
  `automatic bounce: <trigger>` (the literal pattern a verifier greps the diff for).
```

Invariants travel through the checked surface, not by hand-editing the ledger. When a slice
touches an invariant's domain, the contract author restates the invariant as an `[INVARIANT]`
AC in that slice's contract (Phase 1), so the owner sees it and the verifier can bounce it
mechanically (Phase 3). An invariant that proves durable across runs is frozen as an
`[INVARIANT]`-tagged convention through a normal `persist`, exactly like any other
convention, never by editing `CONVENTIONS.md` directly. The point of naming it is that an
agent cannot quietly collapse the distinction: the verifier checks the named relation, not
its own reading of a test that happens to pass.

## The recall packet (output of `galaxy recall`)

```json
{
  "grounding": { "commit": "abc", "stale": false, "reason": null, "changed": [] },
  "partition": { "commit": "abc", "stale": true, "reason": "watch-touched",
                 "staleSlices": [{ "id": "S2-API", "changed": ["apps/api/router.ts"] }] },
  "mustTriage": [{ "id": "R5", "desc": "...", "owner": "...", "severity": "medium",
                   "originRun": "...", "status": "open", "history": [] }],
  "pendingTriage": [{ "riskId": "R5", "action": "defer", "reason": "..." }],
  "decisions": { "file": ".galaxy/DECISIONS.md", "count": 4 },
  "conventions": { "file": ".galaxy/CONVENTIONS.md" },
  "topBounces": [{ "class": "api", "reason": "hollow test", "count": 3 }],
  "ratchet": [{ "class": "api", "level": 0, "eligible": 1, "consecutiveClean": 2, "neverRatchet": false }],
  "lastRun": { "id": "...", "date": "...", "mode": "build", "gate": "green", "commitRange": "a..b" },
  "runCount": 7
}
```

`stale` reasons: `no-stamp`, `missing-commit`, `watch-touched`. `topBounces` is a flat
array sorted by count; the session folds it into the per-class map the workflow script
uses (see `recipes.md`). Partition staleness lives at `partition.staleSlices`.

## Staleness semantics (computed by `galaxy recall`)

A stamp is a commit hash plus watch paths. Recall reports per layer:

- `no-stamp`: never stamped; treat as fully stale, do the full grounding pass.
- `missing-commit`: the stamped commit vanished (rebase, history rewrite); re-verify the
  layer and re-stamp.
- `watch-touched`: `git diff --name-only <stamp>..HEAD` intersects the watch paths; the
  changed files are named. Refresh only what they touch.
- Partition staleness is per slice: `staleSlices` names which slices' paths changed.
  Reuse the partition for clean slices; re-slice only the stale region.

Watch paths are prefixes (e.g. `src/`, `package.json`). Choose them when you write the
layer: for grounding, the structural files whose change would invalidate the prose; for
partition slices, each slice's owned paths.

## Seeding history

There is no importer, deliberately. To seed the factory from prior sprint artifacts
(.mission-control/, .team-review/, or anywhere else): read them in the session, write one
run-report per prior run you want remembered (oldest first, real bounces and risks
included), and `galaxy persist` each. One code path, schema-validated, and the seeded
history drives bounce statistics and ratchet evidence exactly like a live run.

## Anti-fossilization rules

- Verify before trust: anything recall flags stale is checked against current code before
  use. A decision contradicted by reality is re-triaged (supersede or reaffirm), never
  silently applied or silently dropped.
- Baselines are never persisted. Every run measures its own.
- The ledger is append-only and the prose logs are append-only: corrections are new
  entries, so the history of being wrong is itself preserved.
