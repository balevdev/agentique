# Vader hardening: Phase 0 findings

A map of the engine as it stands, and where it can be made more reliable, less rot-prone at
scale, more parallel where safe, faster, and more readable. No code changed yet. Every claim
below carries a `vader.ts` line reference or a measured number. Where I assert a gap, there is
a reproduction.

The engine is `skills/vader/scripts/vader.ts` (1402 lines, one file). It is sound. This is
hardening and a cohesion split, not a rewrite.

## 1. The map

### Commands (CLI dispatch, `main` at 1339-1394)

| command | entry | reads | writes |
|---|---|---|---|
| `init` | `cmdInit` 364 | toolchain, fallow, package.json | `.vader/` scaffold, `state.json`, `gate.json`, prose stubs |
| `gen` | `cmdGen` 546 | `constitution.model.*` | `.vader/generated/checks/*`, locks `state.modelHash` |
| `gate` | `cmdGate` 600 | state, model, `gate.json`, generated checks | nothing (read-only) |
| `recall` | `cmdRecall` 1191 | state, ledger, git | nothing (read-only) |
| `triage` | `cmdTriage` 929 | state | `state.pendingTriage` |
| `persist` | `cmdPersist` 1019 | state, ledger, report | state, LEDGER, DECISIONS, CONVENTIONS |
| `ratchet` | `cmdRatchet` 982 | state, ledger | `state.ratchet.grants` |

State writers: `init`, `gen`, `triage`, `ratchet`, `persist` only. `gate` and `recall` are
pure reads. `saveState` (241) is atomic (tmp + rename). The ledger run-line is appended LAST in
persist (1155) as the crash-recovery commit marker; everything before it is idempotent.

### Where a check actually runs (the gate, `cmdGate` 600-638)

For each invariant, in a serial `for` loop (609-629), `runCheck` (586) spawns one synchronous
`execFileSync` subprocess:

- `rawCheck` -> `bash -c <cmd>`
- `dependency` -> `bun <generated dep script> <root>` (walks the **entire** repo tree, 447-455)
- `data` / `behavioral` -> `bun test <generated test file>`
- `shape` -> `bunx tsc --noEmit --strict --skipLibCheck <generated neg file>`

Plus one `repoCheck` and one optional `fallowCheck`. The aggregate verdict is
`modelHashLocked && repo.pass && (fallow ?? true) && invariants.every(pass)` (630).

## 2. Reliability (priority 1): one real silencing vector, confirmed

### 2.1 The anti-decay lock protects the model text, not the compiled checks it produces

This is the most important finding. `vader gen` locks `hashModel(raw)` over the **model file
text** (570-572). `vader gate` checks that lock (604) and then runs the **on-disk generated
checks as they are** (609-629). Nothing re-derives the generated checks from the model or hashes
them. So an agent that is forbidden to edit `constitution.model.*` can instead edit a file in
`.vader/generated/checks/` to neuter a check, and the gate passes green with the model hash
still locked.

SKILL.md ("Implementer agents ... cannot edit `constitution.model.*` or `generated/` to silence
a failure", anti-decay lock section) and constitution.md ("`generated/` is never hand-edited")
both **claim** generated/ is protected. The engine enforces this by prose only.

Reproduction (run against a fresh repo with `INV-boundary: common must not import etl`):

```
=== gate WITH a real violation present ===
pass: false  modelHashLocked: true  INV-boundary: false
=== agent overwrites .vader/generated/checks/dep-INV-boundary.ts with `process.exit(0)` ===
pass: true   modelHashLocked: true  INV-boundary: true
```

A live architectural violation, gate green, model hash still reported locked. This is exactly
the "new way for an agent to silence a check" the mandate forbids, except it is pre-existing.

Fix direction (Phase 1 slice): extend the lock to cover the generated tree. At `gen`, also lock
a content hash over the emitted `generated/checks/` files; at `gate`, recompute it (or re-derive
the artifacts from the model in memory) and fail closed on any drift, the same fail-closed
behaviour the model-hash mismatch already has (604, 630). This closes the loophole
deterministically and only strengthens an existing guarantee; it adds no new concept.

### 2.2 `gate.json` is also unprotected (decision needed, not an obvious fix)

`cmdGate` reads `repoCheck`/`fallowCheck` from `.vader/gate.json` (605) and runs them verbatim.
`gate.json` is not covered by the lock. An agent can rewrite `repoCheck` to `["true"]` and
silence the entire repo check and fallow at once. Unlike generated/, gate.json is **meant** to
be operator-editable (protocol P-1: "replace its `repoCheck` with the repo's real command"), so
freezing it outright would change the workflow. Options to weigh in Phase 1: fold it into the
same lock so a post-`gen` edit needs a re-`gen` (matches "gate the config, free the code"), or
leave it and just document the trust boundary honestly. This one is a design call for you, not a
silent fix.

### 2.3 What is already airtight (must stay so)

- Triage-gated persist: undispositioned open risks block persist (1042-1047). Pending triage +
  report dispositions merge, report wins (1034-1036).
- Hash lock fail-closed on model mismatch (604, 630) and on `modelHashLocked === false`.
- Append-only ledger, dedup on run id (1027), idempotent re-persist (1050, 1066, 1126, 1132).
- `planTick` (1288) is pure: recall in, plan out, no IO. This is what keeps the parallel,
  sequential, and Pi paths from drifting. Must remain pure.

## 3. Context rot at scale

### 3.1 The plan does not use staleness; every tick fans out over every slice

`recall` computes `staleSlices` (1206-1213): exactly which partition slices a commit touched.
But `planTick` (1288-1300) plans over `recall.partition.slices` (all of them), ignoring
`staleSlices`. The code comment at 1287 acknowledges this: "an adapter may intersect with
recall.partition.staleSlices to skip untouched ones" but no adapter does, and the recipes script
fans out over all slices. In a 50-service repo where one tick touches 2 slices, the loop still
spawns owners and verifier panels for all 50. This is the single largest rot-and-cost driver at
scale. Scoping the plan to touched slices (while still planning everything when the partition
has no stamp, i.e. a fresh baseline) keeps `planTick` pure and keeps all harnesses in agreement,
but it changes what a tick does, so it is a Phase 1 proposal for your review, not a silent
change.

### 3.2 recall makes two git subprocess calls where one would do

`cmdRecall` calls `changedSince` once for the partition (1208) and `staleness` -> `changedSince`
again for grounding (1239), so two `git diff` invocations per recall. Minor at small scale,
real at large-repo scale where a diff is not free. Can share one diff.

### 3.3 `topBounces` key can collide

The bounce map key is the string `` `${line.class} ${line.reason}` `` (1220). A class named
`"a"` with reason `"b c"` and a class `"a b"` with reason `"c"` produce the same key. Low
severity (classes rarely contain spaces) but it is an unforced ambiguity; a tuple/delimiter fix
is trivial.

## 4. Latency and serialisation (measured)

Synthetic model: 4 dependency + 3 shape + 2 data invariants, fresh repo, `repoCheck: ["true"]`.

```
serial gate (current):           2.8 - 3.7 s   (3 runs)
one shape neg file via tsc:      ~0.9 - 1.0 s
THREE neg files in ONE tsc call: ~0.9 - 1.1 s   <-- batching is nearly free
one data check (bun test):       ~0.01 s
one dep check (tree walk):       ~0.01 s
```

The gate's wall-clock is almost entirely **tsc cold start, paid once per shape invariant**, run
serially. dep/data checks are noise here (the tree is tiny). Two findings:

1. **Batch shape checks into a single tsc invocation.** tsc accepts many files at once for the
   same cost as one. Three serial shape checks (~3 s) collapse to one tsc call (~1 s), and the
   win grows with shape count. The only complication is preserving the per-invariant pass/fail
   contract: on failure, attribute by the offending filename in tsc output (each neg file path
   maps to one invariant id; a neg file with no error passed). Deterministic, no prose parsing
   of narratives. Measured: a 9-invariant gate drops from ~3 s to ~1.3 s, >2x.

2. **Run the remaining invariant checks concurrently** (bounded pool, async spawn). Negligible
   here because dep/data are ~0.01 s, but at microservice scale each dependency check walks the
   whole repo tree (447-455); N of them serially is N full walks. Parallelising removes the
   serial sum. Determinism is preserved: the checks are independent, and results are re-sorted
   to model order so the output array is identical regardless of completion order.

Enabling change for both: `runCheck` is `execFileSync` (synchronous). Parallelism needs async
spawn. That is a contained, mechanical change behind the same `{pass, detail}` interface.

Note: the per-dep-check full-tree walk is duplicated work (N dep checks each walk the whole
repo). Sharing one walk would mean the generated checks stop being independently runnable
scripts, which is a deliberate guarantee. Out of scope; named for honesty.

## 5. Module seams (the readability split)

`vader.ts` already has clean section banners that map almost one-to-one onto cohesive modules.
Proposed split (cohesion, not ceremony; ~11 modules + a thin barrel, not twenty shallow files):

| module | contents | source lines |
|---|---|---|
| `model.ts` | constitution types, `validateConstitution`, `hashModel`, `readModel` | 31-101, 254-274 |
| `validate.ts` | shared primitive validators (`fail/obj/str/arr/oneOf/num/...`) | 642-666, 776-790 |
| `state.ts` | state types, `paths`, `defaultState`, load/save, `readLedger`, `validateState`, `validateLedgerLine`, `validateGateConfig` | 103-252, 821-925 |
| `report.ts` | `RunReport` types, `validateReport`, `modelChangeOf` | 141-167, 668-771 |
| `gen.ts` | `globToRegExp`, `gen*` generators, `cmdGen` | 411-574 |
| `gate.ts` | `GateConfig`, detection (`detectFallow`/`detectGate`/`binaryResolves`), `runCheck`, `cmdGate` | 311-354, 576-638 |
| `git.ts` | `git`, `commitExists`, `changedSince`, `underWatch`, `staleness` | 276-309 |
| `init.ts` | `cmdInit`, stubs | 356-409 |
| `ratchet.ts` | `classClean`, `consecutiveClean`, `computeRatchet`, `cmdRatchet` | 945-1003 |
| `persist.ts` | `cmdTriage`, `cmdPersist` (risk lifecycle together) | 927-943, 1005-1167 |
| `recall.ts` | `RecallPacket`, `cmdRecall` | 1169-1259 |
| `plan.ts` | `planTick`, Tick types, `votersFor` | 1261-1300 |
| `vader.ts` | `main`, `flag`, `parseGrant`, `print`, USAGE, and a re-export barrel | 1302-1402 |

Dependency direction is acyclic: `model`/`validate`/`git` are leaves; `state` depends on
`validate`+`model`; commands depend on `state`+leaves; `cli` depends on commands. The test file
imports a broad surface from `./vader.ts` (vader.test.ts:6-27), so `vader.ts` must re-export the
public API; that barrel is the thin interface, not an abstraction tax.

`validate.ts` earns its place: the primitive validators are used by both `report.ts` and
`state.ts`. Everything else is encapsulation, not generic abstraction.

## 6. Fragility / over-fit / surprising (named, mostly out of scope)

- **`genShape` is hardcoded to the temporal example** (501-528). Every shape invariant, whatever
  its `distinct` names, emits the same `pointInInterval` relation with `A` as a branded `number`
  and `B` as a branded `{t0,t1}` interval. For a distinction like Money-vs-Float (both scalars)
  the generated `B` interval type is nonsense; the check only proves the two brands do not
  interchange in that one fixed function. The assessment doc already concedes the gold path is
  "most true for TS"; this is the concrete reason. Generalising it is feature scope, not this
  task. Named for honesty; do not let the refactor oversell what a green shape check proves.
- **The lock is textual, not semantic** (254, 570): reformatting the model (whitespace, comment)
  changes the hash and fails the gate until re-`gen`. This is arguably correct (any edit is
  gated) but it is a sharp edge worth a one-line doc note.
- **`computeRatchet` is O(classes x runs)**: `consecutiveClean` (953) re-filters the whole
  ledger per class. Ledgers are small; low priority, easy to hoist if it ever matters.

## 7. What this implies for Phase 1 (preview, not the plan)

Seam-first ordering of the slices, reliability before everything:

1. Close the generated-check silencing vector (2.1). Pure hardening, highest priority.
2. The module split (section 5), seam-first: leaves (`model`, `validate`, `git`), then `state`,
   then commands, then the barrel. One batch at a time, full suite green between each.
3. Gate latency: batch shape checks into one tsc + async-parallel the rest (section 4), with
   before/after numbers.
4. Scale rot: scope the plan to stale slices (3.1) and de-duplicate recall's git calls (3.2).
   These change tick behaviour, so they need your explicit sign-off.

Open decisions for you before Phase 1: whether to lock `gate.json` (2.2), and whether to scope
`planTick` to stale slices (3.1). Both are behaviour changes, not silent fixes.
```
