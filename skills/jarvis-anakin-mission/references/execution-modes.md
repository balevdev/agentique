# Execution modes

Read this during preflight. It decides who runs the protocol and how parallel work stays safe.
The phases, artifacts, and rubric never change. Only the executor changes.

## Preflight checklist

Answer these about the host before Phase 1. When in doubt, assume the weaker capability and
pick the safer mode. Record the answers under a `HOST` heading in `GROUNDING.md`.

1. Can you spawn subagents at all?
2. If yes, can several run at once, or only in series?
3. Can a subagent spawn its own subagents? Assume no unless proven otherwise.
4. Is a shell available to run build, type, lint, and test commands?
5. Is git available, and does the host support per agent worktrees?

## Mode selection

Sizing comes from the real module boundaries found in Phase 0, not from a fixed shape. Pick the
weakest mode the host forces, then run the slice count the repo actually warrants.

- Parallel Teams: several parallel subagents, no nesting required. Fan out the owners in one
  batch, then the verifiers in a second batch. In build mode the design step, if a tournament is
  warranted, runs its proposers in one batch then its critics in a second.
- Sequential Slices: subagents exist but are few or serial. Spawn one fresh subagent per slice in
  slice order, each writing its own report, then spawn the verifiers. A fresh subagent per slice
  keeps context clean and avoids cross slice leakage. A build tournament degrades to proposals
  written in series, each a fresh subagent that has not seen the others, then one critic pass.
- Solo: no subagents. The orchestrator plays every role one slice at a time. Between slices, reset
  context by re reading only `GROUNDING.md`, the next slice contract, and in build mode `DESIGN.md`,
  so a prior slice cannot pollute the next. Accept each slice with fresh eyes before scoring it. A
  build tournament degrades to alternatives the orchestrator writes in series with a hard reframe
  between each (for example optimize one for simplicity, the next for change resilience, the next
  for time to first working slice), then a fresh eyes critique and synthesis.

In every mode the spawn tree stays one level deep. Owners, critics, and verifiers spawn nothing.
Only the orchestrator spawns. Never skip the verifier role or the written record of rejected
alternatives, since an unchallenged single plan is the weakest one you can ship.

## VCS isolation

Parallel writers can collide at the version control layer even when their file sets are disjoint,
because a shared index and shared build output are not disjoint. Choose one:

- Single tree, default. Owners never run commit. They leave edits in the working tree. The
  orchestrator commits at phase boundaries, one commit per team or per phase, so history is
  attributable. This works on almost every host.
- Per agent worktree, preferred when supported. Each owner gets its own git worktree or branch,
  the verifier merges its team branch, and the orchestrator merges team branches at the gate. True
  write isolation, but needs host support.

In both cases, never let an owner run a formatter, codegen, or build that rewrites files outside
its slice. Generated output and lockfiles are read only unless the slice owns the generator.

## Subagent failure handling

Treat every spawned agent as potentially flaky. After a subagent returns, the orchestrator
validates rather than trusts:

1. Does the expected artifact exist at its deterministic path?
2. Does it parse and contain the required fields?
3. Does the diff for that slice actually exist if work was claimed?

If any check fails, re spawn that one agent once with the identical brief. If it fails again, mark
the slice FAILED in `SLICES.md`, record it as a residual risk with the reason, and continue. One
unhealthy agent must never block the sprint or corrupt the aggregate, which counts a FAILED slice
as undelivered, not as shipped.

## Budgets

- Critique budget: a critic judges each design once. The orchestrator breaks a tie by recording
  why it chose the winner.
- Bounce budget: a verifier bounces an owner at most once. A standing disagreement after the
  bounce escalates to the orchestrator, who decides and records why.
- Effort budget: an owner that cannot satisfy its contract within reasonable effort defers the
  slice with a residual risk rather than looping.
- Residual budget: the gate stops looping once the logged residual budget is reached, and the
  remaining unmet criteria become prioritized residual risks in the summary.
