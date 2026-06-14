---
description: Run exactly one vader factory tick (build a roadmap item or review a slice batch) over this repo, driven by /loop
argument-hint: [idea, roadmap item, or "review"; omit to continue the next pending item]
---

Run exactly one tick of the vader software factory on this repo. Optional input: $ARGUMENTS

- If `.vader/` does not exist, this is the first run. If $ARGUMENTS says "review", run a review
  of the existing repo; otherwise treat $ARGUMENTS as the idea and run build P-1 to P1 before
  the first build tick.
- If `.vader/` exists, ignore $ARGUMENTS unless it names a specific roadmap item or "review",
  and continue the next pending work.

## Load first, before any other action

Read `references/protocol.md` and follow it exactly: it is the authority on the phases, the two
human gates, and the tick boundary. Read `references/constitution.md` before writing or
changing the model, `references/recipes.md` for the fan-out script and the owner and verifier
prompts, `references/acceptance-gate.md` for the verifier law, and `references/adapters.md` for
the harness fan-out.

The vader CLI is `bun <skill-dir>/scripts/vader.ts` with `--root` this repo.

## The tick

1. Recall. `vader recall --root <repo>`. Trust nothing flagged stale until verified against the
   current repo. Note `topBounces` and the ratchet: they set verifier voter counts.
2. First run only. If there is no frozen model: build mode runs P-1 (ground), P0 (conceive:
   write SPEC.md and `constitution.model.json`, then STOP for the human gate), P1 (decompose
   into a roadmap of disjoint slices, freeze contracts, `vader gen`). Review mode runs P-1 then
   P1 (partition the repo into disjoint slices, `vader gen`). Do not start a build tick in the
   same firing as the conceive gate.
3. Implement (P2). Fan out owners over the slice's disjoint `slicePaths` with the `Workflow`
   tool per `references/recipes.md`: critic, seam owner alone, sibling owners in parallel, each
   in an isolated worktree at the base sha.
4. Verify (P3). Cross-assigned refute-first verifiers run the acceptance gate, then `vader gate
   --root <repo>`. A failed invariant id is an automatic bounce back to P2. The gate failing
   closed on an unlocked model hash means someone touched the protected model: stop and report,
   do not work around it.
5. Persist (P4). Triage every open risk first (`vader triage <id> <finding|defer|close>
   --reason ...`); persist refuses otherwise. Then assemble the `RunReport` and run `vader
   persist <run-report.json> --root <repo>`: a green build gate marks the item done; a genuine
   missing distinction parks a `modelChange` proposal and blocks the item. Never auto-apply a
   model change.

## Then pace the loop

- More pending work and nothing blocked on a model gate: schedule the next tick with
  `ScheduleWakeup` and stop. Pass this same `/vader` input back so the next firing continues.
- Work done, or the next item is blocked on a parked model change (a human gate): stop and
  report. Do not loop on a gate only a human can open.

## Non-negotiables

- Gate the model, free the code. The only human gates are freeze-the-model (P0) and
  change-the-model (a parked proposal). Everything between is autonomous.
- The model and `generated/` are protected. Owners never edit `constitution.model.*` or
  `.vader/generated/`. The gate fails closed if the model hash is unlocked.
- One slice batch per tick. Disjoint slices, frozen contracts. A contract change is a
  model-change proposal, not an edit.
- Triage before persist. Every open risk carries a disposition or the tick cannot close.
- Persist always. A tick that did not `vader persist` is a failed tick.
- Build simple. Deep modules, thin interfaces, one pattern per concern, functional-first strict
  TypeScript, no `any`, no unsafe casts, no em or en dashes. Minimalism over abstraction.
