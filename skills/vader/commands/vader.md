---
description: Run exactly one vader factory tick (one roadmap item) over this repo, driven by /loop
argument-hint: [idea or roadmap item; omit to continue the next pending item]
---

Run exactly one tick of the vader software factory on this repo. Optional input: $ARGUMENTS
(If `.vader/` does not exist yet, this is the first run: treat $ARGUMENTS as the idea and go
through P-1 to P1 before the first build tick. If it exists, ignore $ARGUMENTS unless it
names a specific roadmap item and continue the next pending item.)

## Load first, before any other action

1. The `vader` skill, the protocol. Read `references/protocol.md` and follow it exactly; it
   is the authority on the phases, the two human gates, and the tick boundary. Read
   `references/constitution.md` before writing or changing the model.

The vader CLI is `bun <skill-dir>/scripts/vader.ts` with `--root` this repo.

## The tick

1. **Recall.** `vader recall --root <repo>`. Trust nothing flagged stale until verified
   against the current repo.
2. **First run only.** If there is no frozen model: run P-1 (ground), P0 (conceive: write
   SPEC.md and `constitution.model.json`, then STOP for the human gate), P1 (decompose into a
   roadmap of disjoint slices, freeze contracts, `vader gen`). Do not start a build tick in
   the same firing as the conceive gate.
3. **Build tick.** Take exactly one `pending` roadmap item (or the one named in $ARGUMENTS):
   - P2 implement: fan out owners over the item's disjoint `slicePaths` with the `Workflow`
     tool, each in an isolated worktree at the item's base sha.
   - P3 verify: refute-first verifiers, then `vader gate --root <repo>`. A failed invariant
     id is an automatic bounce back to P2. The gate failing closed on an unlocked model hash
     means someone touched the protected model: stop and report, do not work around it.
4. **Persist.** `vader persist --root <repo>`: green marks the item done; a genuine missing
   distinction parks a `modelChange` proposal and blocks the item. Never auto-apply a model
   change.

## Then pace the loop

- More `pending` items and nothing blocked on a model gate: schedule the next tick with
  `ScheduleWakeup` and stop. Pass this same `/vader` input back so the next firing continues.
- Roadmap done, or the next item is blocked on a parked model change (a human gate): stop and
  report. Do not loop on a gate only a human can open.

## Non-negotiables

- **Gate the model, free the code.** The only human gates are freeze-the-model (P0) and
  change-the-model (a parked proposal). Everything between is autonomous.
- **The model and `generated/` are protected.** Owners never edit `constitution.model.*` or
  `.vader/generated/`. The gate fails closed if the model hash is unlocked.
- **One roadmap item per tick.** Disjoint slices, frozen contracts. A contract change is a
  model-change proposal, not an edit.
- **Persist always.** A tick that did not `vader persist` is a failed tick.
