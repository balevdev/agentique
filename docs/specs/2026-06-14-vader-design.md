# vader: an app-agnostic software factory for agentic loops

Status: design, awaiting review
Date: 2026-06-14
Home: `agentique/skills/vader/`

## Goal

Turn one idea into shipped, invariant-checked code in any repo root, driven by `/loop`, without architecture decay. vader fuses two things:

1. Our existing factory approach (disjoint slices, owner/verifier split, frozen contracts, ledger, ratchet, recall/persist) proven in `anakin-galaxy`.
2. The "compiled contract outside the agent" idea: a dense, human-reviewable model of the system's architectural intent that fails deterministically when an agent collapses a semantic distinction.

The decay vader exists to kill: an agent makes a locally correct change (a test passes) that quietly weakens a global architectural invariant (collapses a distinction the system needed to preserve). vader makes that distinction a machine-checkable artifact, so the violation becomes a gate failure, not a judgment call, and the loop cannot weaken the model to make the failure disappear.

## Non-goals (v1)

- Not a formal theorem prover. We do not ship Lean/TLA+ per repo. We borrow the idea (name the distinction in one dense model) without the prover tax.
- Not multi-language gold paths at v1. TypeScript gets the strongest enforcement; every other language gets a deterministic floor.
- Not coupled to the Mandate Intelligence domain. No MI personas in core; domain personas are an optional drop-in.

## Core decisions (locked with the operator)

- **Engine**: neutral model plus an enforcement router that emits the strongest available check per invariant kind per language. TS-first gold path, universal floor everywhere. (See "Invariant engine".)
- **Autonomy**: gate the model, free the code. Human approval at exactly two moments: freezing the initial spec+model, and any later change to the model. Full autonomy between those gates.
- **Tick granularity**: one `/loop` tick takes one roadmap item through implement, verify, persist, fanning out parallel slices inside the tick via the `Workflow` tool.
- **Lineage**: fresh, self-contained spine that lifts the galaxy CLI design (recall/persist/ledger/ratchet) and the owner/verifier/frozen-contract protocol. No MI personas in core; personas are an optional plugin.
- **Name**: vader. Command `/vader`, CLI `vader.ts`, model file = `constitution`.

## The on-disk contract

`vader init` scaffolds this into any target repo:

```
.vader/
  constitution.model.ts    # THE TRUTH. concepts + distinctions + invariants tagged by kind. human-gated.
  generated/               # router output: nominal types, lint rules, property tests, AST scripts. NEVER hand-edited.
  spec/
    IDEA.md                # the seed
    SPEC.md                # deep prose spec derived from the idea (prose is where you explore)
    ROADMAP.md             # decomposed work items
  state.json               # loop state: roadmap, status, current phase, model hash, ratchet
  LEDGER.jsonl             # verifier bounces -> next-tick calibration
  runs/<id>/               # per-tick: slices, frozen contracts, run-report
  gate.json                # resolved check command(s) for THIS repo: tsc/eslint/pytest/cargo + generated checks
```

The split is load-bearing and taken straight from the source idea: `SPEC.md` is prose where you explore; `constitution.model.ts` is the compiled truth that fails; `generated/` is the teeth. Prose explores, the model compiles, the generated checks bite. For non-TS repos the model lives in `constitution.model.yaml` (same shape).

## The pipeline (one arc, idea to shipped)

- **P-1 Ground** — detect language/toolchain, refresh the repomap index, resolve the gate command into `gate.json`. The app-agnostic adapter layer.
- **P0 Conceive** — idea -> deep `SPEC.md` (automated back-and-forth, pulls in `deep-research` for unknowns) -> first `constitution.model`. HUMAN GATE.
- **P1 Decompose** — spec+model -> `ROADMAP.md` -> disjoint slices; critic red-teams; contracts frozen. Router emits `generated/` so owners code against real teeth.
- **P2 Implement** — owners build against frozen contracts in worktree isolation (parallel file-mutating owners must use worktree isolation; forks come from the base sha).
- **P3 Verify** — refute-first verifiers accept work they did not write; the gate (repo check + generated invariant checks) is the deterministic arbiter. An invariant id in the fail set is an automatic bounce, zero judgment.
- **P4 Persist** — update state/ledger/ratchet. If a slice genuinely needs the model to change, that becomes a model-change proposal -> human gate, never auto-applied. This is the anti-decay lock.

## The loop

One `/loop` tick = take one roadmap item from frozen contract through implement/verify/persist, using `Workflow` to fan out parallel slices within the tick. The tick ends by either self-scheduling the next (`ScheduleWakeup`) or stopping (roadmap exhausted, or blocked waiting on a human model-gate). `state.json` makes every tick resumable; a tick is stateless beyond what it reads from and writes to `.vader/`.

vader ships a slash command (`/vader`) that `/loop` drives. The model-change gate is the only thing that pauses the loop for a human between the initial freeze and completion.

## Invariant engine

### The constitution model schema

A typed, hand-readable declaration. In a TS repo it is `constitution.model.ts`, so the repo's own `tsc` validates the model itself; non-TS repos use `constitution.model.yaml` with the same shape.

```ts
export const constitution = {
  concepts: {
    TemporalPoint:    { kind: "shape", note: "a moment, not a duration" },
    TemporalInterval: { kind: "shape", note: "exists from t0 to t1" },
  },
  invariants: [
    { id: "INV-point-not-interval", kind: "shape",
      statement: "A temporal point is never coerced into an interval.",
      check: { distinct: ["TemporalPoint", "TemporalInterval"],
               relation: "pointInInterval(p, iv) requires p:TemporalPoint, iv:TemporalInterval" } },
    { id: "INV-etl-boundary", kind: "dependency",
      statement: "common/ must not import etl/.",
      check: { forbidImport: { from: "common/**", to: "etl/**" } } },
    { id: "INV-telemetry-side-effect-free", kind: "behavioral",
      statement: "Observability must not change a stage's ack/NAK/DLQ outcome.",
      check: { contractTest: "telemetry-failure-preserves-outcome" } },
  ],
} as const
```

Invariants are tagged by one of four kinds, because checkability differs fundamentally:

- **shape** — a semantic distinction in types/data (point vs interval).
- **dependency** — a structural/import boundary.
- **behavioral** — a property only provable by exercising behavior.
- **data** — an algebraic law over values (deterministic id = hash of fields).

### The router (model to teeth)

`vader gen` reads the model and emits, per `(kind x language)`, the strongest available enforcement:

| kind | TS gold path (real compile error) | universal floor (any language) |
|---|---|---|
| shape | branded/nominal types + a type-level test (`@ts-expect-error`) proving the mix will not compile | newtype wrapper + generated property test on a runtime guard |
| dependency | dependency-cruiser / eslint boundary rule | AST/grep script returning nonzero on violation |
| behavioral | a contract-test stub the owner must satisfy | same, in the repo's test framework |
| data | fast-check property test | example-based test |

The gold path is where "it becomes a compile error in my spec" literally happens. The floor path keeps the same model entry deterministic in any language, as a generated test, never a judgment call.

### The gate

`vader gate` runs `repo-check + generated-checks` and returns a structured pass/fail keyed by invariant id. That structured result is what P3 verifiers consume. This is the concrete upgrade over the current galaxy, where invariant ACs are verifier-read prose: here the same invariants are machine-checked and an id in the fail set is an automatic bounce.

### The anti-decay lock

Implementer agents can make code fail the gate; they physically cannot edit `constitution.model.*` or `generated/` to make a failure vanish (enforced by the slice contract path boundaries and a guard in `vader gate` that fails if the model hash in `state.json` does not match the working-tree model). Only P4 can raise a model-change proposal, and applying it is a human gate. This is the structural defense against an agent "fixing" the gate by weakening the invariant.

## Packaging (plug-and-go, self-contained)

- Lives at `agentique/skills/vader/` with `SKILL.md`, `scripts/vader.ts` (bun, zero runtime deps, mirrors `galaxy.ts`), `references/protocol.md`.
- Distributed via skills.sh: `npx skills add balevdev/agentique --skill vader`.
- `vader init` scaffolds `.vader/` into any repo and writes `gate.json` by detecting the toolchain. Nothing global, nothing repo-specific baked in.

## Validation strategy

- `vader.ts` ships with `vader.test.ts` (galaxy precedent): recall/persist/ledger/ratchet are pure and unit-tested.
- Router gets golden-file tests: a fixture model in, asserted `generated/` artifacts out, per language.
- Dogfood proof: run vader idea-to-ship on two throwaway repos, one TS (proves the gold path produces a real compile error when an invariant is violated) and one Python (proves the floor path), confirming app-agnostic in one pass.

## Risks and assumptions

- **R1 Router breadth.** The four-kind taxonomy may not cover every real invariant. Mitigation: an `escape: { rawCheck: "<command>" }` check form lets any invariant attach an arbitrary command at the floor while we learn the taxonomy.
- **R2 Spec quality gates everything.** A weak `SPEC.md`/model produces a weak factory output. Mitigation: P0 is human-gated and may loop with `deep-research`; the model can only be ratcheted up autonomously, never down.
- **R3 Autonomy stall.** "Gate the model" means a missing invariant can block a slice until a human approves a model change. Accepted by design: a stall that asks for human steering beats silent decay.
- **R4 Worktree/gate attribution.** Carried forward from galaxy: parallel owners need worktree isolation or verifier out-of-bounds checks see the union of edits. Encoded in the P2 owner preamble.
- **A1** Target repos have a resolvable single gate command (or vader can compose one) at P-1.
- **A2** `Workflow` (or an equivalent fan-out primitive) is available in the host; Solo fallback exists for hosts without subagents, as in `jarvis-anakin-mission`.

## Open questions for review

1. Should `vader init` refuse to run in a repo with no detectable toolchain, or scaffold a minimal `gate.json` for the operator to fill?
2. Is the four-kind invariant taxonomy the right starting set, or do we want a fifth kind up front (for example, performance/SLA invariants)?
3. Does the spec belong in `agentique/docs/specs/` (here) or should it live under the eventual `skills/vader/` directory once the skill exists?
