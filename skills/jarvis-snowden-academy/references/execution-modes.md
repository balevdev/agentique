# Execution modes

Read this during preflight. It decides who runs the protocol and how parallel work stays
safe. The phases, artifacts, and scoring never change. Only the executor changes.

## Preflight checklist

Answer these about the host before partitioning. When in doubt, assume the weaker
capability and pick the safer mode.

1. Can you spawn subagents at all?
2. If yes, can several run at once, or only in series?
3. Can a subagent spawn its own subagents? Assume no unless proven otherwise.
4. Is a shell available to run build, type, lint, and test commands?
5. Is git available, and does the host support per agent worktrees?

Record the answers in `GROUNDING.md` under a `HOST` heading, then pick a mode.

## Mode selection

- Parallel Teams: several parallel subagents, no nesting required. Run the full shape, six
  workers in one fan out, then two verifiers in a second fan out.
- Sequential Slices: subagents exist but are few or serial. Spawn one fresh subagent per
  slice in slice order, each writing its own report, then spawn verifiers per team. A
  fresh subagent per slice keeps context clean and avoids cross slice leakage.
- Solo: no subagents. The orchestrator plays every role one slice at a time. Between
  slices, reset working context by re reading only `GROUNDING.md` and the next slice, so a
  prior slice cannot pollute the next. Audit each slice against its diff with fresh eyes
  before scoring, because a self grade is the weakest signal available.

In every mode the spawn tree stays one level deep. Verifiers and workers never spawn
anything. Only the orchestrator spawns. A subagent that tries to delegate will usually
stall silently, which is the most common multi agent failure.

## VCS isolation

Parallel writers can collide at the version control layer even when their file sets are
disjoint, because a shared index and shared build output are not disjoint. Choose one:

- Single tree, default. Workers never run commit. They leave edits in the working tree.
  The orchestrator commits at phase boundaries, one commit per team or per phase, so
  history is attributable. This works on almost every host.
- Per agent worktree, preferred when supported. Each worker gets its own git worktree or
  branch, the verifier merges its team branch, and the orchestrator merges team branches
  at the gate. This gives true write isolation but needs host support.

In both cases, never let a worker run a formatter, codegen, or build that rewrites files
outside its slice. Generated output and lockfiles are read only unless the slice owns the
generator.

## Subagent failure handling

Treat every spawned agent as potentially flaky. After a subagent returns, the orchestrator
validates rather than trusts:

1. Does the expected artifact exist at its deterministic path?
2. Does its `report.json` parse and contain the required fields?
3. Does the diff for that slice actually exist if fixes were claimed?

If any check fails, re spawn that one agent once with the identical brief. If it fails
again, mark the slice FAILED in `SLICES.md`, record it as a residual risk with the reason,
and continue. One unhealthy agent must never block the sprint or corrupt the aggregate.
The aggregate counts a FAILED slice as unverified, not as passing.

## Budgets

- Bounce budget: a verifier bounces a worker at most once. A standing disagreement after
  the bounce escalates to the orchestrator, who decides and records why.
- Effort budget: a worker that cannot verify a fix within reasonable effort defers it with
  a residual risk rather than looping.
- Residual budget: the convergence gate stops looping once the logged residual budget is
  reached, and the remaining red items become prioritized residual risks in the summary.
