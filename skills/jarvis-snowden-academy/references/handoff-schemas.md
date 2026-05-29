# Handoff schemas

Read this during Phases 2 through 5. Every handoff produces a human report in Markdown and
a machine readable `report.json` sidecar next to it, so the orchestrator aggregates by
parsing structured data rather than reading prose. All artifacts live under
`.team-review/runs/<run-id>/` and each has exactly one writer.

## Severity

- high: incorrect behavior, data loss, or a type hole that can crash or corrupt.
- med: a value violation, a leaky interface, or a missing test on real behavior.
- low: cosmetic, dead code, or a minor smell.

## Worker report

Path: `reports/<AGENT>.md` and `reports/<AGENT>.report.json`.

```
# <AGENT> report
Slice: <paths>   Owner: <AGENT>

## Capabilities
- <capability> : <one line of public behavior>

## Issues found (delta from baseline)
- [<id>] <high|med|low> <file> : <description>

## Fixes applied
- [<id>] <change summary> : <files touched>

## Deferred and escalations
- [seam] <seam path> needs <change> because <reason>, depends on <slices>
- [defer] <issue id> not fixed because <reason>, residual risk <...>

## Verification (scoped to slice)
- build / types / lint / tests : <results>

## Self score (rubric below)
correctness, simplicity_layering, interface_design, type_safety, tests_e2e,
blast_discipline, each 0 to 5, subtotal xx / 30

## Residual risks
- <...>
```

Sidecar `report.json`:

```json
{
  "agent": "FS-W",
  "slice": ["apps/web"],
  "capabilities": ["..."],
  "issues": [{ "id": "W1", "severity": "high", "file": "...", "desc": "..." }],
  "fixes": [{ "id": "W1", "files": ["..."], "summary": "..." }],
  "escalations": [{ "seam": "...", "change": "...", "depends_on": ["..."] }],
  "deferred": [{ "id": "W3", "reason": "...", "risk": "..." }],
  "verification": { "build": "pass", "types": "pass", "lint": "pass", "tests": "12/0" },
  "score": { "correctness": 4, "simplicity_layering": 5, "interface_design": 4,
             "type_safety": 5, "tests_e2e": 3, "blast_discipline": 5, "subtotal": 26 },
  "status": "complete"
}
```

## Verifier report

Path: `reports/<TEAM>-VERIFIER.md` and `reports/<TEAM>-VERIFIER.report.json`.

```
# <TEAM> verifier report
Slices reviewed: <AGENTS>

## Worker verdicts
- <AGENT>: accept | bounce(<specific reasons>)

## Independent verification (team surface, vs baseline)
- build / types / lint / tests : <results>

## Integration issues
- <cross slice or seam break> : <owning slice> : <status>

## Adjusted scores
- <AGENT>: subtotal xx / 30

## Team verdict and score
verdict: ready | blocked
team_score: xx / 100
```

Sidecar fields: `team`, `verdicts` (agent to accept or bounce with reasons),
`verification`, `integration_issues`, `adjusted_scores` (agent to subtotal),
`team_verdict`, `team_score`.

## Summary

Path: `SUMMARY.md`. Also point `.team-review/SUMMARY.md` at the latest run.

```
# Jarvis Snowden Academy summary
Repo: <name>   Commit: <sha>   Run: <run-id>   Mode: <execution mode>

## Capability matrix
<all slices, all capabilities, grouped by team>

## Issue ledger (delta from baseline)
found: n   fixed: n   deferred: n   failed slices: n

## Convergence gate (vs baseline)
build / types / lint / e2e : pass | fail | n/a (<why>)

## Scores
per slice, per team, overall, each xx / 100

## Residual risks and next sprint
- <prioritized, each with an owner>
```

## Scoring rubric

Score each slice on six dimensions, 0 to 5, then normalize the 30 point subtotal to 100.
Weights are equal by default and may be tuned per repo. Team score is the mean of its
slices after the verifier adjustment. Overall is the mean of teams. A FAILED slice scores
0 and is reported as unverified, not as passing.

1. Correctness: bugs found and fixed against bugs remaining, measured from baseline.
2. Simplicity and layering: adherence to the values, penalizing needless abstraction.
3. Interface design: thin interface over a deep module, encapsulation, no side effect leaks.
4. Type safety: strict, no `any`, no unsafe casts.
5. Tests and E2E: coverage of real behavior, not line count theater.
6. Blast discipline: changes minimal, in slice, seams respected, no scope creep.

A score is a claim the verifier can confirm from the diff and the gate. Unverifiable
optimism is capped at the verifier's independent number.
