# Vader hardening: Phase 1 plan

Disjoint slices, ordered reliability-first then seam-first for the refactor. Each slice names
what it changes, the invariant it must not break, and how it is proven green. Full check suite
(`bun test` in `skills/vader/scripts`, 49 tests today; plus `bunx tsc --noEmit`) must pass after
each batch before the next starts. Baseline: 49 pass, 0 fail, ~3.3 s; gate over a 9-invariant
model ~3 s.

Two delegated decisions, now resolved:
- gate.json: locked into the gen-time enforcement lock (edit before freeze, re-`gen` to change).
- plan scoping: `planTick` annotates `touched`, never drops a slice; review scopes via the
  recipe with a seam-blast-radius rule. No engine assumption about tick intent.

## Batch A: close the generated-check + gate.json silencing vector (priority 1)

The headline reliability gap from findings section 2.1/2.2. Lands first, on the current single
file, before any refactor churn.

- **Changes.** `cmdGen` (vader.ts 546) computes an `enforcementHash`: a sha256 over the sorted
  list of `(relative path, content)` for every file it just wrote under `generated/checks/`,
  plus the current `gate.json` content. It stores `state.enforcementHash` next to `modelHash`.
  `cmdGate` (600) recomputes the same hash from disk and compares; `pass` requires it to match,
  reported as a new `GateResult.enforcementLocked` field (mirroring `modelHashLocked`). `State`
  type and `validateState` gain `enforcementHash: string | null`.
- **Lock-engagement semantics.** `null` means "not yet compiled" and does not fail the gate
  (exactly like `modelHash === null` at 604), so a fresh repo and the existing tests stay green.
  It engages after the first `gen`, and re-engages after an approved model change re-`gen`s. This
  reuses the existing fail-closed pattern; it adds no new gate concept, only widens what the lock
  covers from "model text" to "model text + compiled enforcement surface".
- **Invariant it must not break.** Determinism (hash over a sorted file list, stable across
  hosts). Idempotent `gen`. Model-hash lock semantics unchanged. The gate still fails closed on a
  model mismatch and on `modelHashLocked === false`. No legitimate flow blocked: the operator
  edits `gate.json` before P1 `gen` (protocol P-1), and `gen` is cheap and idempotent.
- **Proof.** New tests: (1) tamper a generated dep check to `process.exit(0)` ->
  `enforcementLocked: false`, `pass: false` (this is the exact doc repro, now caught); (2) edit
  `gate.json` after `gen` -> fails closed; (3) `gen` then `gate` on a clean model -> green,
  `enforcementLocked: true`; (4) re-`gen` after a model edit re-locks both hashes. All 49
  existing tests stay green. Manual re-run of the findings repro must now show `pass: false`.

## Batch B: gate latency (parallel + batched, determinism preserved)

Findings section 4. Measured target: 9-invariant gate ~3 s -> ~1.3 s.

- **Changes.** `runCheck` (586) becomes async (`execFile`/`Bun.spawn`) behind the same
  `{ pass, detail }` shape. In `cmdGate`, collect all `shape` neg files and run them in ONE
  `tsc --noEmit --strict --skipLibCheck <file...>` invocation; attribute pass/fail per id by the
  offending filename in tsc output (each neg path maps to one id; a neg file with no error
  passed). Run the remaining invariant checks (dep, data, behavioral, raw) concurrently with a
  bounded pool (`min(cpu-2, n)`), then re-sort results into model order.
- **Invariant it must not break.** The per-invariant `{ id, pass, detail }` list is byte-identical
  in content and ORDER to today (re-sorted to model order regardless of completion order).
  Aggregate `pass` unchanged. Fail-closed behaviour preserved (a missing/unreadable generated
  file still fails its id). No behavioural change, only scheduling.
- **Proof.** Existing per-id gate tests stay green (they assert `invariants.find(id).pass`). New
  test: a model with two shape invariants, one collapsed; gate attributes the failure to the
  collapsed id only and passes the other. Report before/after wall-clock on the 9-invariant
  synthetic model.

## Batch C: the module split (seam-first, the barrel is the seam)

Findings section 5. The test imports a broad surface from `./vader.ts` (vader.test.ts 6-27), so
`vader.ts` stays as the entry and becomes a thin re-export barrel. That barrel IS the seam:
settle it first, then move code behind it incrementally, suite green after each sub-batch.

- **C0 (seam).** Decide and freeze the `vader.ts` public re-export list = exactly the symbols the
  tests import today, no more. This is the thin interface every later move preserves.
- **C1 leaves.** `model.ts` (constitution types, `validateConstitution`, `hashModel`,
  `readModel`), `validate.ts` (shared primitives `fail/obj/str/arr/oneOf/num/...`), `git.ts`
  (`git`, `commitExists`, `changedSince`, `underWatch`, `staleness`). `vader.ts` re-exports.
- **C2 state.** `state.ts` (state types, `paths`, `defaultState`, load/save, `readLedger`,
  `validateState`, `validateLedgerLine`, `validateGateConfig`) depending on `validate`+`model`.
- **C3 producers.** `gen.ts` (router + generators + `cmdGen`), `gate.ts` (`GateConfig`,
  detection, `runCheck`, `cmdGate`), `report.ts` (`RunReport` + `validateReport`), `init.ts`.
- **C4 memory.** `ratchet.ts`, `persist.ts` (with `cmdTriage`), `recall.ts`, `plan.ts`.
- **C5 cli.** `vader.ts` retains `main`, `flag`, `parseGrant`, `print`, `USAGE`, and the barrel.
- **Invariant it must not break.** The import surface from `./vader.ts` is unchanged (tests are
  the contract). No behaviour change anywhere; pure code movement. Dependency graph stays acyclic
  (`model`/`validate`/`git` leaves -> `state` -> commands -> `cli`). No file becomes a shallow
  pass-through: `validate.ts` exists only because both `report` and `state` use the primitives.
- **Proof.** `bun test` (all 49) and `bunx tsc --noEmit` green after each of C1..C5. `tsconfig`
  `include` updated to the new files. CLI smoke tests (vader.test.ts 701-741) green.

## Batch D: scale rot (annotate, dedup, de-collide)

Findings sections 3.1, 3.2, 3.3. Runs on the split modules.

- **Changes.** `planTick` (plan.ts after C) adds `touched: boolean` to each `TickSlice`, derived
  purely from `recall.partition.staleSlices`; it still returns every slice (never drops one).
  `references/recipes.md` and `references/adapters.md` gain the review-scoping rule: a review
  re-verification tick fans out only over `touched` siblings, EXCEPT when any seam slice is
  touched, in which case it fans out fully (seam blast radius). `cmdRecall` computes
  `changedSince` once and reuses it for both grounding and partition staleness. The `topBounces`
  map key becomes a delimiter-safe tuple instead of `` `${class} ${reason}` ``.
- **Invariant it must not break.** `planTick` stays pure (recall in, plan out, no IO) so all
  harnesses still agree. Determinism preserved. No slice is dropped from the plan by the engine;
  scoping is an explicit, documented driver choice, never a silent under-cover. Grounding and
  partition staleness verdicts are identical to today (the dedup is a refactor, not a semantics
  change). `topBounces` counts are identical except previously-colliding distinct keys now
  separate correctly.
- **Proof.** `planTick` tests assert `touched` matches `staleSlices`. A recall test with a stale
  grounding path and a stale partition slice still reports both correctly after the dedup. A
  `topBounces` test with two distinct class/reason pairs that previously collided now counts them
  separately. Full suite green.

## Out of scope (named in findings, deliberately not touched)

- `genShape` hardcoded to the temporal example (findings 6): generalising it is feature scope.
  The refactor must not let the writeup oversell what a green shape check proves.
- Per-dep-check full-tree-walk de-duplication: would break the "each generated check is an
  independently runnable script" guarantee.
- `computeRatchet` O(classes x runs): ledgers are small; not worth the change now.

## Definition of done for the execution phase

- `vader.ts` split into the cohesive modules above, each readable on its own, behind a thin
  barrel; the test import surface unchanged.
- The generated-check + gate.json silencing vector closed, with a test that fails before the fix
  and passes after.
- A measured gate-latency improvement (before/after numbers on the synthetic model).
- No invariant weakened, no guardrail removed; `planTick` still pure; determinism intact.
- Findings doc and this plan committed alongside the change.
```
