# Authoring the constitution

The constitution is the one thing a human owns and protects. It is a single JSON (or `.ts`)
file, `.vader/constitution.model.json`, that names the semantic distinctions the build must
never collapse. Everything else in `.vader/` is generated or derived.

Two rules govern it:

1. **The model is human-gated.** It is frozen at conceive (P0) and changed only through a
   parked, human-approved proposal. `vader gen` locks its hash when it compiles the model;
   `vader gate` fails closed if the on-disk model no longer matches the lock.
2. **`generated/` is never hand-edited.** `vader gen` owns `.vader/generated/checks/`
   entirely. If a check is wrong, the model is wrong. Fix the model and regenerate. This is
   mechanically enforced, not just a convention: `vader gen` locks an enforcement hash over the
   generated checks and `gate.json`, and `vader gate` fails closed if either drifts.

## Shape

```json
{
  "concepts": {},
  "invariants": [
    { "id": "INV-...", "kind": "...", "statement": "...", "check": { ... } }
  ]
}
```

Each invariant has a stable `id` (the gate reports pass/fail by this id), a human `kind`, a
one-line `statement`, and a `check` whose shape selects the router that compiles it. There
are four kinds, because an invariant is not one thing: different distinctions are checkable
in different ways. A fifth `rawCheck` escape hatch exists for anything the four cannot
express.

## shape: a semantic distinction in types or data (the TS gold path)

The canonical decay this whole system exists to stop: a temporal **point** silently coerced
into a temporal **interval**, so "is this point inside this interval" collapses into
"do these two intervals overlap". Name the two types as distinct and they cannot be
confused.

```json
{
  "id": "pt-not-interval",
  "kind": "shape",
  "statement": "a temporal point is not a temporal interval",
  "check": { "distinct": ["TemporalPoint", "TemporalInterval"] }
}
```

`vader gen` emits two TypeScript files: a `.types.ts` with branded nominal types and a
`.neg.ts` whose `@ts-expect-error` lines prove the distinction holds. If an agent collapses
the two types, a `@ts-expect-error` stops erroring and `tsc` fails on that exact line. This
is the gold path: a real compile error, not a generated test. Non-TS repos get the universal
floor instead (a generated property test).

## dependency: an import or structural boundary

```json
{
  "id": "common-not-etl",
  "kind": "dependency",
  "statement": "common must not import etl",
  "check": { "forbidImport": { "from": "common/**", "to": "etl/**" } }
}
```

`vader gen` emits a standalone bun script that scans every file matching `from` for an import
matching `to` and exits nonzero on any violation. Globs use `*` (one segment) and `**` (any
depth).

## data: an algebraic law over values

```json
{
  "id": "merge-idempotent",
  "kind": "data",
  "statement": "merging a record with itself is the record",
  "check": { "law": "merge(x, x) === x", "sample": { "kind": "int", "count": 200 } }
}
```

`vader gen` emits a seeded, zero-dep property test. The repo supplies the law body at
`.vader/laws/law-<id>.ts` exporting `law(input): boolean`. The generator owns the sampling
and the assertion; you own the law.

## behavioral: a property provable only by exercising behavior

```json
{
  "id": "retry-preserves-outcome",
  "kind": "behavioral",
  "statement": "a retried request yields the same outcome as the first",
  "check": { "contractTest": "retry-outcome" }
}
```

`vader gen` emits a contract test that stays red until the owner provides the harness at
`.vader/contracts/retry-outcome.ts` exporting `run(): { outcomePreserved: boolean }`. The
distinction is named now; the proof arrives with the slice that implements it.

## escape: rawCheck

When none of the four fit, give the gate a literal command. Use sparingly: a `rawCheck` is
opaque to the router and earns none of the gold-path guarantees.

```json
{
  "id": "no-todo-in-shipped",
  "kind": "hygiene",
  "statement": "no TODO markers survive into src",
  "check": { "rawCheck": "! grep -rn 'TODO' src" }
}
```

The `kind` on a `rawCheck` invariant is free text; the router dispatches on the `check`
shape, not the kind label.

## Where this fits

The constitution is the protected source of truth the rest of the factory is built around.
`references/protocol.md` is the phase pipeline that freezes it (P0) and parks any later change.
`references/recipes.md` is how a tick fans out owners and verifiers against the checks `vader
gen` compiles here. `references/acceptance-gate.md` is the verifier law: a missing distinction
surfaced there becomes a `modelChange` proposal at persist, parked for the human gate and never
applied by the loop.
