# Init: obtain the repo's knowledge

Goal: after init, any fresh context can act like an engineer who already knows
this repo — from one `recall` call. Everything here is learned from the code,
never invented. Nothing is written inside the repo.

## 1. Register and discover the gate

`init --repo .` registers the project (identity = origin URL, so clones and
moves are the same project). Then find the commands that already define
"correct" here: typecheck, lint, test, build — from package.json scripts,
Makefile, CI config, whatever the repo actually uses. If `fallow` is on PATH
and the repo has (or can trivially take) a `.fallowrc`, include
`fallow audit --gate new-only` as a structural step.

Store them via `gate set` (stdin JSON: `[{command, reason}]`, ordered). Then
run the whole gate once. It must be green before any factory work: a red
baseline → report the failures and stop — fixing it is the human's call (they
may make it the first task).

## 2. Map the architecture into knowledge sections

Prefer `repomap` when available (`repomap index`, then `repomap ask` /
`repomap graph`). Otherwise dispatch read-only Explore scouts. Either way you
are extracting facts; every claim must be checkable against a file path.

Store each fact via `knowledge set` (stdin JSON: kind, title, body,
paths_glob, verified_sha = current HEAD). Kinds:

- `layout` — what each top-level module owns, one section per area, with
  `paths_glob` covering it (globs are what scope staleness checks later —
  set them carefully).
- `boundary` — dependency rules the code actually observes ("domain/ never
  imports infra/"). Only rules the code follows today or the human states;
  note violations honestly. Boundaries go into every mission's `00-intel.md`
  and inline into implementer briefs.
- `convention` — naming, error handling, test placement; the dominant pattern
  a new change is expected to follow.
- `sensitive_zone` — paths where a defect is expensive: auth, money,
  migrations, public API contracts, data deletion. Specific paths, not vibes.
  Touching one makes the auditor stage mandatory in the stage plan, and they
  are in every packet.
- `gotcha` — real, non-obvious traps only.

Keep bodies short — a map, not a wiki: point to files rather than restating
them. Aim for what v1 fit in ~150 lines total.

## 3. Mechanize what deserves it

For each boundary that matters and is cheap to enforce, propose a hardening
task (an eslint `no-restricted-imports` rule, a fallow boundary, a failing
test) — it goes through intake like anything else and is approved before any
mission runs it. A boundary lives in a tool someone else
maintains, or it lives in a knowledge section — never in a bespoke engine.

## Maintaining the map (every phase, forever)

- Mission open checks `knowledge stale --paths <the task's paths>` once,
  before writing `00-intel.md`; stale sections get re-verified (repomap or a
  quick read) and re-stamped via `knowledge set` with the new `verified_sha`.
- When a mission teaches something a newcomer would need, add it at close —
  the smallest edit that captures the fact.
- When reality contradicts the map, the map is wrong: fix it in the same
  mission and say so in the journal. A confident stale map is worse than no
  map.
- Cross-project standing preferences of the human (dependency policy, style
  instincts) belong in `prefs set`, not per-project sections.
