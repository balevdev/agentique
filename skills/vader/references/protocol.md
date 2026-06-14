# Vader protocol

The phase pipeline. Vader runs in two modes over one engine.

- build: one idea becomes shipped, invariant-checked code. P-1 and P0 run once; P1 lays the
  roadmap once; P2 to P4 run once per `/loop` tick, one roadmap item at a time, until the
  roadmap is done or blocked on a model gate.
- review: an existing repo is audited and hardened. P-1 grounds a fresh baseline; P1 partitions
  the repo into disjoint slices; P2 to P4 run per slice batch. A review run carries no
  `itemId`; it stamps a partition instead of advancing a roadmap.

Both modes share the same spine: disjoint slices, frozen contracts, refute-first verifiers who
never bless their own work, the compiled-constitution gate, the acceptance gate as the P3
verifier prompt, and a triage-gated persist.

## P-1 Ground

Establish a fresh, trustworthy baseline before any reasoning.

- `vader init --root <repo>` if `.vader/` is absent. Scaffolds state, detects the toolchain,
  detects fallow, writes `gate.json`. The model hash is locked later, at P1 `vader gen`.
- `vader recall --root <repo>`. The packet flags every stale layer (grounding and partition
  staleness by commit and watch paths), the open risks that must be triaged, `topBounces`, the
  evidence-derived ratchet, the next item, and any parked model change. Anything stale is
  verified against the current repo before it is trusted, never silently applied.
- Build or refresh the repomap so slices reference real files, not assumed ones.
- Read `gate.json`. If `detectGate` fell back to the stub (no toolchain found), replace its
  `repoCheck` with the repo's real build/test/lint command before P3 can mean anything. If a
  `.fallowrc` is present and `fallow` resolves, `fallowCheck` is already wired and runs as a
  structural step in the gate.

## P0 Conceive (HUMAN GATE, build mode only)

Turn one idea into the two frozen artifacts.

- Write `.vader/spec/SPEC.md`: purpose, constraints, success criteria, the data model, the
  boundaries that must hold.
- Write `.vader/constitution.model.json` (see `references/constitution.md`): the semantic
  distinctions the build must never collapse, as the four invariant kinds.
- Stop. A human approves SPEC.md plus the model. This is the freeze-the-model gate. The
  approved model hash is locked at P1 by `vader gen`, when the model is compiled into the
  enforced checks. Nothing else in the pipeline asks a human.

A review run skips P0: the constitution already exists (or is authored once for the repo under
review and frozen the same way).

## P1 Decompose or partition

Turn the work into a set of independently shippable, disjoint slices.

- build: the spec becomes a roadmap. Each item names `slicePaths`, the file globs it owns.
  Slices must not overlap, so parallel owners never collide. Freeze the contracts between
  slices (types, signatures, on-disk shapes) before any owner runs. A contract change mid-build
  is a model-change proposal, not an edit.
- review: the repo becomes a partition. Each slice is a class plus the paths it covers; the
  partition is stamped at a commit so recall can later tell which slices a later change made
  stale.
- `vader gen --root <repo>` compiles the constitution into `.vader/generated/checks/`. This is
  the deterministic surface every tick is measured against. Regenerating is clean: old checks
  are removed first. `vader gen` also locks the compiled model hash in `state.json`: this is
  where the anti-decay lock engages, so any later edit to the model without a re-gen fails the
  gate closed.

## P2 Implement

Take exactly one roadmap item (build) or one slice batch (review) from pending to built. Fan
out with the harness primitive per `references/recipes.md`:

- The critic red-teams the partition first. A blocking finding stops the tick before code.
- The seam owner builds alone, so siblings fork from a settled interface.
- Sibling owners build in parallel, each in an isolated worktree reset to the base sha, so a
  failed slice never poisons the tree.
- Owners write code only inside their `slicePaths` and carry the MANTRA (the Ladder plus deep
  modules and thin interfaces). They never touch `constitution.model.*` or
  `.vader/generated/`; the anti-decay lock makes a silenced failure impossible.

## P3 Verify (the acceptance gate)

Prove the work before persisting it.

- Cross-assigned refute-first verifiers run `references/acceptance-gate.md` verbatim against a
  slice they did not write. Each returns ACCEPT or REJECT with file:line evidence. Voter count
  scales with evidence: three for a high-risk slice (a `neverRatchet` class, a class in
  `topBounces`, or a frozen seam), one otherwise. A slice passes only by majority ACCEPT.
- `vader gate --root <repo>` is the deterministic arbiter underneath the verifiers: repo check
  plus fallow (when configured) plus every generated check, returning `pass` and a per-invariant
  pass/fail list. A failed invariant id is an automatic bounce, no discussion. The gate fails
  closed if `modelHashLocked` is false (someone touched the protected model).
- A REJECT or a failed id is a slice `bounce`: the verifier records `{ac, reason}`, the slice
  returns to its owner, and the bounce is carried into the run report so the ledger remembers
  it.

## P4 Persist (triage-gated, anti-decay aware)

Close the tick deterministically. Assemble one `RunReport` and call `vader persist`.

- Triage first. Every open risk must carry a disposition (`finding`, `defer`, or `close`),
  recorded with `vader triage` or inline in the report. Persist refuses if any open risk is
  undispositioned: debt cannot carry silently across a tick.
- Green gate, build mode: the item is marked `done`. Review mode: the partition stamp advances.
- The run line and one bounce line per bounce append to the ledger. A class that bounced or saw
  a non-green gate has its granted ratchet level auto-demoted to zero.
- A genuine missing distinction (a verifier NOTE that the constitution should name something it
  does not) becomes a `modelChange`: persist parks it in `state.json` and blocks the item. It is
  never auto-applied. A human approves it at the change-the-model gate, after which `vader gen`
  recompiles and the lock re-freezes.

## The tick and pacing

One roadmap item (build) or one slice batch (review) per `/loop` firing. After P4, either:

- More pending work and nothing blocked on a model gate: schedule the next tick with
  `ScheduleWakeup` and stop.
- Work is done, or the next item is blocked on a parked model change: stop and report. Do not
  loop on a gate that only a human can open.
