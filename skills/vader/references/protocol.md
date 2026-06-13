# Vader protocol

The phase pipeline. Phases P-1 through P0 run once per project. P1 runs once to lay the
roadmap. P2 through P4 run once per `/loop` tick, one roadmap item at a time, until the
roadmap is done or blocked on a model gate.

## P-1 Ground

Establish a fresh, trustworthy baseline before any reasoning.

- `vader init --root <repo>` if `.vader/` is absent. This scaffolds state, detects the
  toolchain, writes a stub `gate.json`, and locks the model hash.
- `vader recall --root <repo>`. Anything flagged stale is verified against the current repo
  before it is trusted, never silently applied.
- Build or refresh the repomap so slices reference real files, not assumed ones.
- Read `gate.json`. If `detectGate` fell back to the stub (no toolchain found), replace its
  `repoCheck` with the repo's real build/test/lint command before P3 can mean anything.

## P0 Conceive (HUMAN GATE)

Turn one idea into the two frozen artifacts.

- Write `.vader/SPEC.md`: the deep spec. Purpose, constraints, success criteria, the data
  model, the boundaries that must hold.
- Write `.vader/constitution.model.json` (see `references/constitution.md`): the semantic
  distinctions the build must never collapse, as the four invariant kinds.
- **Stop. A human approves SPEC.md plus the model.** This is the freeze-the-model gate.
  `vader init` locks the approved model hash. Nothing else in the pipeline asks a human.

## P1 Decompose

Turn the spec into a roadmap of independently shippable, disjoint slices.

- Each roadmap item names `slicePaths`: the file globs it owns. Slices must not overlap, so
  parallel owners never collide.
- Freeze the contracts between slices (types, function signatures, on-disk shapes) before
  any owner runs. A contract change mid-build is a model-change proposal, not an edit.
- `vader gen --root <repo>` compiles the constitution into `.vader/generated/checks/`. This
  is the deterministic surface every tick is measured against.

## P2 Implement (one item per tick)

Take exactly one roadmap item from `pending` to built.

- Use the `Workflow` tool to fan out owners across the item's disjoint slices, each in an
  isolated worktree reset to the item's base sha, so a failed slice never poisons the tree.
- Owners write code only inside their `slicePaths`. They may not touch
  `constitution.model.*` or `.vader/generated/` (the anti-decay lock makes a silenced
  failure impossible, but owners should never try).

## P3 Verify

Prove the item before persisting it.

- Refute-first verifiers: spawn independent checkers prompted to break the slice, not to
  bless it.
- `vader gate --root <repo>`. The gate runs the repo check plus every generated check and
  returns `pass` plus a per-invariant pass/fail list. **A failed invariant id is an
  automatic bounce**: the item goes back to P2, no discussion. The gate also fails closed if
  `modelHashLocked` is false (someone touched the protected model).

## P4 Persist

Close the tick deterministically.

- Green gate: `vader persist` marks the item `done`.
- Failed gate that the verifiers judge a genuine gap in the model (a distinction the
  constitution should name but does not): `vader persist` with a `modelChange` blocks the
  item and parks the proposal in `state.json`. It is never auto-applied. A human approves it
  at the change-the-model gate, after which `vader gen` recompiles and the lock re-freezes.

## The tick and pacing

One roadmap item per `/loop` firing. After P4, either:

- Roadmap has more `pending` items and nothing is blocked on a model gate: schedule the next
  tick with `ScheduleWakeup` and stop.
- Roadmap is done, or the next item is blocked on a parked model change: stop and report. Do
  not loop on a gate that only a human can open.
