# Execution modes

Read this during preflight. It decides who runs the protocol and how parallel work stays
safe. The phases, artifacts, and scoring never change. Only the executor changes.

## Preflight checklist

Answer these about the host before decomposing. When in doubt, assume the weaker
capability and pick the safer mode.

1. Can you spawn subagents at all?
2. If yes, can several run at once, or only in series?
3. Can a subagent spawn its own subagents? Assume no unless proven otherwise.
4. Is a shell available to run build, type, lint, and test commands?
5. Is git available, and does the host support per agent worktrees?

Record the answers in `MISSION.md` under a `HOST` heading, then pick a mode.

## Mode selection

- Parallel Teams: several parallel subagents, no nesting required. Run the full shape. The
  design tournament is three proposers in one fan out then two critics in a second fan out.
  The build is up to six builders in one fan out then two verifiers in a second fan out.
- Sequential Slices: subagents exist but are few or serial. Run the tournament as two or
  three proposals spawned in series, each a fresh subagent, then one critic pass. Build one
  fresh subagent per slice in slice order, each writing its own report, then spawn verifiers
  per team. A fresh subagent per slice keeps context clean and avoids cross slice leakage.
- Solo: no subagents. The orchestrator plays every role one step at a time. See the
  degradation below. Between slices, reset working context by re reading only `MISSION.md`,
  `DESIGN.md`, and the next slice contract, so a prior slice cannot pollute the next. Accept
  each slice against its contract with fresh eyes before scoring it, because a self grade is
  the weakest signal available.

In every mode the spawn tree stays one level deep. Builders, critics, and verifiers never
spawn anything. Only the orchestrator spawns. A subagent that tries to delegate will usually
stall silently, which is the most common multi agent failure.

## Degrading the design tournament without subagents

The tournament exists to stop the team from committing to one unexamined shape. That value
must survive even with no parallelism, so it degrades rather than disappears.

- Sequential Slices: write two or three proposals one at a time, each in a fresh subagent
  that has not seen the others, then run a single critic pass over all of them, then
  synthesize.
- Solo: the orchestrator writes the proposals itself, in series, with a hard reframe between
  each so they do not collapse into the same idea. A useful reframe is to change the driving
  priority each time, for example optimize the first for simplicity, the second for change
  resilience, the third for time to first working slice. Then re read them with fresh eyes,
  red team each against the constraints in `MISSION.md`, and synthesize. Never skip the
  critique or the written record of rejected alternatives. An unchallenged single design is
  the weakest plan you can ship, and it is the failure this phase exists to prevent.

## VCS isolation

Parallel builders can collide at the version control layer even when their file sets are
disjoint, because a shared index and shared build output are not disjoint. Choose one:

- Single tree, default. Builders never run commit. They leave edits in the working tree. The
  orchestrator commits at phase boundaries, one commit per team or per phase, so history is
  attributable. This works on almost every host.
- Per agent worktree, preferred when supported. Each builder gets its own git worktree or
  branch, the verifier merges its team branch, and the orchestrator merges team branches at
  the gate. This gives true write isolation but needs host support.

In both cases, never let a builder run a formatter, codegen, or build that rewrites files
outside its slice. Generated output and lockfiles are read only unless the slice owns the
generator.

## Subagent failure handling

Treat every spawned agent as potentially flaky. After a subagent returns, the orchestrator
validates rather than trusts:

1. Does the expected artifact exist at its deterministic path?
2. Does its `report.json` parse and contain the required fields?
3. Does the diff for that slice actually exist if a build was claimed?

If any check fails, re spawn that one agent once with the identical brief. If it fails
again, mark the slice FAILED in `SLICES.md`, record it as a residual risk with the reason,
and continue. One unhealthy agent must never block the sprint or corrupt the aggregate. The
aggregate counts a FAILED slice as unbuilt, not as shipped.

## Budgets

- Critique budget: critics judge each design once. The orchestrator breaks a tie by
  recording why it chose the winner.
- Bounce budget: a verifier bounces a builder at most once. A standing disagreement after
  the bounce escalates to the orchestrator, who decides and records why.
- Effort budget: a builder that cannot satisfy its contract within reasonable effort defers
  the slice with a residual risk rather than looping.
- Residual budget: the integration gate stops looping once the logged residual budget is
  reached, and the remaining unmet criteria become prioritized residual risks in the
  summary.
