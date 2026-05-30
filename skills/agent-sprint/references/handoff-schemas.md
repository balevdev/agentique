# Handoff schemas

Read this from Phase 2 on. Every handoff is ONE structured artifact, a single `report.json`,
written to a deterministic path with exactly one writer. There is no second prose report; the
orchestrator aggregates by parsing the JSON. Artifacts live under the run directory
(`.mission-control/runs/<run-id>/` for build, `.team-review/runs/<run-id>/` for review). The
planning documents `GROUNDING.md`, `SLICES.md`, and in build mode `DESIGN.md` and `ROADMAP.md`
live at the top of the mode's directory, since they persist across runs.

## Severity

- high: a slice misses a core acceptance criterion, a seam is wrong, the build is broken in a way
  that blocks dependents, or behavior is incorrect in a way that can crash or corrupt.
- med: a mantra violation, a leaky interface, or a missing test on real behavior.
- low: cosmetic, dead code, or a minor smell.

## Owner report

Path: `reports/<AGENT>.report.json`. One per slice. The `capabilities`, `acceptance`, and `seams`
fields carry the build work; `issues` and `fixes` carry the review work. A slice uses the fields
its mode produces and omits the rest.

```json
{
  "agent": "PR-UI",
  "mode": "build",
  "slice": ["apps/web/saved-search"],
  "contract": "PR-UI",
  "capabilities": ["create, list, and delete a saved search"],
  "acceptance": [
    { "id": "AC1", "status": "met", "check": "saved-search.e2e: create" }
  ],
  "issues": [],
  "fixes": [],
  "seams": {
    "exposed": [],
    "consumed": [{ "seam": "SavedSearch", "owner": "FN-C" }]
  },
  "escalations": [{ "seam": "...", "change": "...", "depends_on": ["..."] }],
  "deferred": [{ "id": "AC4", "reason": "...", "risk": "..." }],
  "verification": {
    "build": "pass", "types": "pass", "lint": "pass",
    "existing_tests": "no regression", "acceptance_tests": "6/0"
  },
  "verdict": "ready",
  "status": "complete"
}
```

- `acceptance[].status` is `met`, `partial`, or `unmet`, and `check` names the test or observable
  check that proves it. A criterion with no such check is not met.
- `issues[]` (review) are `{ "id", "severity", "file", "desc" }`; `fixes[]` are
  `{ "id", "files", "summary" }`.
- `verdict` is the owner's own `ready` or `blocked` call. It is a claim, not a score; the verifier
  re derives it independently.

## Verifier report

Path: `reports/<TEAM>-VERIFIER.report.json`. One per team.

```json
{
  "team": "Surface",
  "slices_reviewed": ["PR-UI", "DT-IX"],
  "verdicts": { "PR-UI": "accept", "DT-IX": "bounce: AC2 backed by a hollow test" },
  "acceptance_audit": [
    { "agent": "PR-UI", "id": "AC1", "result": "confirmed" },
    { "agent": "DT-IX", "id": "AC2", "result": "bounce: no test exercises the criterion" }
  ],
  "verification": {
    "existing_surface": "no regression", "acceptance_tests": "green"
  },
  "integration_issues": [{ "issue": "...", "owner": "DT-IX", "status": "open" }],
  "team_verdict": "blocked"
}
```

The verifier judges criteria coverage, not pass counts. A criterion claimed met but backed by no
code, no passing check, or a check that does not exercise the behavior is a bounce. `acceptance_audit`
results are `confirmed` or a `bounce: <reason>`.

## Summary

Path: `SUMMARY.md` in the run directory; point the mode's top level `SUMMARY.md` at the latest run.

```
# Sprint summary
Mode: build | review   Repo: <name>   Commit: <sha>   Run: <run-id>   Exec: <execution mode>

## Capability map
<all slices, all capabilities delivered or inventoried, grouped by team>

## Status (delta from baseline)
shipped: n   deferred: n   blocked: n   failed slices: n
per milestone and slice: shipped | deferred | blocked

## Gate (two sided, vs baseline)
existing surface (no regression) / acceptance criteria : pass | fail | n/a (<why>)

## Verdicts
per slice and per team: ready | blocked

## Residual risks and next sprint
- <prioritized, each with an owner>
- build only: the diff is clean in the working tree; recommend a review sprint to harden it.
```

## Verdict rubric

A slice is `ready` when every core acceptance criterion is `met` with a named check the verifier
confirmed from the diff, no high severity issue is open, and the changes respect the mantra and
the slice's blast radius. It is `blocked` otherwise. A team is `ready` only when all its slices are
`ready` and its integration issues are closed.

There is no 0 to 100 number. The defensible signal is the acceptance audit: which criteria are met,
each tied to a check the verifier re ran. Unverifiable optimism is capped at what the verifier can
confirm. A FAILED slice is `blocked` and reported as undelivered, not as shipped.
