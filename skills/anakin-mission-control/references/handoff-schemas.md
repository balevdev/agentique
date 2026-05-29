# Handoff schemas

Read this during Phases 1 through 6. Every handoff produces a human report in Markdown and a
machine readable `report.json` sidecar next to it, so the orchestrator aggregates by parsing
structured data rather than reading prose. The handoff artifacts (design proposals, builder
and verifier reports, and the summary) live under `.mission-control/runs/<run-id>/`, each
with exactly one writer. The planning documents `MISSION.md`, `DESIGN.md`, `ROADMAP.md`, and
`SLICES.md` live at the top `.mission-control/` level, since they persist across runs.

## Severity

- high: the slice does not meet a core acceptance criterion, a seam is wrong, or the build
  is broken in a way that blocks dependents.
- med: a value violation, a leaky interface, a missing test on real behavior, or a criterion
  met only partially.
- low: cosmetic, dead code, or a minor smell.

## Design proposal

Path: `design/<PROPOSER>.md` and `design/<PROPOSER>.report.json`. One per proposer in
Phase 1.

```
# <PROPOSER> proposal
Driving priority: <what this approach optimizes for>

## Architecture and module boundaries
## Key data flows
## Build sequence
## Tradeoffs
## Riskiest assumption
```

Sidecar fields: `proposer`, `priority`, `boundaries` (list), `risks` (list),
`riskiest_assumption`.

## Critic verdict

Path: `design/CRITIC-<n>.md` and `design/CRITIC-<n>.report.json`. Scores every proposal.

```
# Critic <n> verdict
## Per proposal
- <PROPOSER>: <failure modes, hidden cost, irreversible decisions, scope leaks>
  fit to constraints: <notes>   design_score: xx / 25
```

Score each proposal on the design selection rubric below, not the slice rubric, because a
proposal has no code, tests, or types yet to score. Sidecar fields: `critic`, `verdicts`
(proposer to notes plus `design_score`).

## Builder report

Path: `reports/<AGENT>.md` and `reports/<AGENT>.report.json`.

```
# <AGENT> report
Slice: <paths>   Owner: <AGENT>   Contract: <slice id>

## Capabilities delivered
- <capability> : <one line of public behavior>

## Acceptance criteria
- [AC1] met | partial | unmet : <test name or observable check>

## Seam activity
- exposed: <seam this slice published>
- consumed: <seams used, owners>

## Escalations and deferrals
- [seam] <seam> needs <change> because <reason>, depends on <slices>
- [defer] <criterion> not met because <reason>, residual risk <...>

## Verification (scoped to slice)
- build / types / lint : <results>
- existing tests (no regression) : <results>
- new acceptance tests (red to green) : <results>

## Self score (rubric below)
contract_fidelity, simplicity_layering, interface_design, type_safety, tests_e2e,
integration_blast, each 0 to 5, subtotal xx / 30

## Residual risks
- <...>
```

Sidecar `report.json`:

```json
{
  "agent": "PR-UI",
  "slice": ["apps/web/saved-search"],
  "contract": "PR-UI",
  "capabilities": ["..."],
  "acceptance": [{ "id": "AC1", "status": "met", "check": "saved-search.e2e: create" }],
  "seams": { "exposed": [], "consumed": [{ "seam": "SavedSearch", "owner": "FN-C" }] },
  "escalations": [{ "seam": "...", "change": "...", "depends_on": ["..."] }],
  "deferred": [{ "criterion": "AC4", "reason": "...", "risk": "..." }],
  "verification": { "build": "pass", "types": "pass", "lint": "pass",
                    "existing_tests": "no regression", "acceptance_tests": "6/0" },
  "score": { "contract_fidelity": 5, "simplicity_layering": 5, "interface_design": 4,
             "type_safety": 5, "tests_e2e": 4, "integration_blast": 5, "subtotal": 28 },
  "status": "complete"
}
```

## Verifier report

Path: `reports/<TEAM>-VERIFIER.md` and `reports/<TEAM>-VERIFIER.report.json`.

```
# <TEAM> verifier report
Slices reviewed: <AGENTS>

## Builder verdicts
- <AGENT>: accept | bounce(<specific reasons>)

## Acceptance audit (per slice, criterion by criterion)
- <AGENT> AC1: confirmed | bounce(<no code | no test | hollow test | not met>)

## Independent verification (team surface, two sided)
- existing surface (no regression) : <results>
- new acceptance tests (green) : <results>

## Integration issues
- <cross slice or seam break> : <owning slice> : <status>

## Adjusted scores
- <AGENT>: subtotal xx / 30

## Team verdict and score
verdict: ready | blocked
team_score: xx / 100
```

A criterion claimed met but backed by no code, no passing test, or a test that does not
actually exercise the behavior is a bounce. A green check on a hollow test is the easiest
way for a build to lie to itself, so the verifier judges criteria coverage, not just pass
counts.

Sidecar fields: `team`, `verdicts` (agent to accept or bounce with reasons),
`acceptance_audit`, `verification`, `integration_issues`, `adjusted_scores` (agent to
subtotal), `team_verdict`, `team_score`.

## Summary

Path: `SUMMARY.md`. Also point `.mission-control/SUMMARY.md` at the latest run.

```
# Anakin Mission Control summary
Repo: <name>   Commit: <sha>   Run: <run-id>   Mode: <execution mode>

## Capability matrix
<all slices, all capabilities delivered, grouped by team>

## Roadmap status
shipped: n   deferred: n   blocked: n   failed slices: n
per milestone and slice: shipped | deferred | blocked

## Integration gate (two sided, vs baseline)
existing surface (no regression) / milestone acceptance criteria : pass | fail | n/a (<why>)

## Scores
per slice, per team, overall, each xx / 100

## Residual risks and next sprint
- <prioritized, each with an owner>

## Handoff
The diff is clean in the working tree. Recommend a code review sprint to harden it.
```

## Design selection rubric

Score each Phase 1 proposal on five dimensions, 0 to 5, subtotal xx / 25. This selects the
winner and shapes the synthesis only. It does not enter the slice scores, because a proposal
is judged on the quality of the plan, not on code that does not exist yet.

1. Fit to constraints and goal: solves the actual mission inside the stated constraints and
   non goals, without quietly assuming out of scope work.
2. Simplicity: the simplest shape that works, with the fewest moving parts.
3. Risk and reversibility: names its riskiest assumption, avoids irreversible bets, and
   fails cheaply when an assumption is wrong.
4. Sequencing: delivers value early, puts the riskiest and most depended on work first, and
   leaves the repo working between milestones.
5. Seam clarity: clean module boundaries that can become disjoint slices with stable seams.

## Scoring rubric

Score each slice on six dimensions, 0 to 5, then normalize the 30 point subtotal to 100.
Weights are equal by default and may be tuned per repo. Team score is the mean of its slices
after the verifier adjustment. Overall is the mean of teams. A FAILED slice scores 0 and is
reported as unbuilt, not as shipped. Phase 1 proposals are scored separately on the design
selection rubric above and do not enter the slice scores.

1. Contract fidelity: acceptance criteria met against criteria claimed, confirmed by tests
   that actually exercise the behavior.
2. Simplicity and layering: adherence to the values, penalizing needless abstraction and
   gold plating beyond the contract.
3. Interface design: thin interface over a deep module, clean seam, no side effect leaks.
4. Type safety: strict, no `any`, no unsafe casts.
5. Tests and E2E: acceptance criteria encoded as real tests of behavior, not line count
   theater.
6. Integration and blast discipline: changes minimal and in slice, seams respected, the
   slice delivers real end to end behavior, no scope creep.

A score is a claim the verifier can confirm from the diff and the gate. Unverifiable
optimism is capped at the verifier's independent number.
