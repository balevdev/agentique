# vader factory merge: one spine, build + review, parallel, ponytail-folded

Status: approved (operator, 2026-06-14), implementing
Date: 2026-06-14
Home: `agentique/skills/vader/`
Supersedes nothing. Extends `2026-06-14-vader-design.md` with the memory machinery that
the original spec promised but the shipped `vader.ts` did not yet carry.

This document is the CONTRACT. The independent acceptance gate (see "Acceptance gate")
verifies the delivered diff against the clauses here, by file:line, and against the
invariants at the bottom. A clause with no concrete pointer does not pass.

## Goal

Make `vader` the single software factory for `agentique`. It keeps its differentiator
(the compiled constitution: a human-gated, hash-locked model that fails the gate
deterministically when an agent collapses a named distinction) and absorbs the memory
machinery proven in `anakin-galaxy` (verify-before-trust recall, triage-gated persist,
evidence-derived ratchet, bounce-pattern ledger, decisions/conventions/grounding prose).
It gains a `review` mode beside `build`, runs fallow as a structural gate step, folds in
the ponytail lazy-senior instinct, and ships a parallel owner/verifier orchestration recipe
plus a thin harness-adapter contract. It stays app-agnostic: zero MI in core.

## Scope of THIS phase (Phase 1, core)

In scope: the merged `vader.ts` engine + tests; the doc set (SKILL, protocol, recipes,
acceptance-gate, constitution update, command, adapter contract). Out of scope (named so
the bijection check does not flag them as gaps): migrating MI's `.galaxy/` memory into
`.vader/` (Phase 2); rewriting MI personas/commands to be vader-aware (Phase 2); deleting
the galaxy skills from agentique (Phase 2, paired with MI migration so the MI repo is never
stranded); real Pi/Hermes/Codex adapters (Phase E). Phase 1 ships the adapter CONTRACT and
the Claude Code (Workflow) path only.

## Files this phase touches (the explicit list; anything else is divergence)

- `skills/vader/scripts/vader.ts` (rewrite: merge galaxy memory machinery in)
- `skills/vader/scripts/vader.test.ts` (extend: cover every new clause)
- `skills/vader/SKILL.md` (rewrite: build+review, parallel, fallow, ponytail, adapters)
- `skills/vader/references/protocol.md` (rewrite: phases with fan-out + triage + acceptance gate)
- `skills/vader/references/recipes.md` (new: the Workflow orchestration script, vader-ified)
- `skills/vader/references/acceptance-gate.md` (new: the operator's 5-pass independent gate)
- `skills/vader/references/adapters.md` (new: the thin harness-adapter contract)
- `skills/vader/references/constitution.md` (light edit: cross-link, no semantic change)
- `skills/vader/commands/vader.md` (rewrite: build+review tick, acceptance gate, triage)
- `docs/specs/2026-06-14-vader-factory-merge-design.md` (this file)

## The merged on-disk contract (`.vader/`)

```
.vader/
  constitution.model.json   # THE TRUTH. concepts + invariants. human-gated, hash-locked.
  generated/checks/         # router teeth. never hand-edited.
  GROUNDING.md              # glossary, module graph, seams, mantra. session-owned prose.
  DECISIONS.md              # append-only ADR log. written by persist.
  CONVENTIONS.md            # append-only frozen conventions. written by persist.
  spec/ IDEA.md SPEC.md ROADMAP.md
  state.json                # CLI-owned machine state (schema below)
  LEDGER.jsonl              # CLI-owned append-only: run + bounce lines
  gate.json                 # repoCheck + optional fallowCheck for THIS repo
  runs/<id>/                # session-owned: SLICES.md, contracts/, reports/, run-report.json
```

### state.json (merged)

```ts
type State = {
  version: 1
  modelHash: string | null                    // vader: hash-lock of the constitution
  roadmap: RoadmapItem[]                       // vader: build-mode pacing
  pendingModelChange: { proposedBy: string; reason: string; diff: string } | null  // vader anti-decay
  grounding: { commit: string | null; watch: string[] }     // galaxy: stamp
  partition: { commit: string | null; slices: PartitionSlice[] }  // galaxy: stamp
  risks: Risk[]                                // galaxy: with history
  pendingTriage: { riskId: string; action: TriageAction; reason: string }[]
  decisions: string[]                          // galaxy: ids; prose in DECISIONS.md
  ratchet: { grants: Record<string, Grant>; neverRatchet: string[] }  // galaxy: evidence-derived
}
```

The old `ratchet.consecutiveCleanTicks` counter is replaced by galaxy's evidence-derived
per-class ratchet (computed from the ledger, not stored as a running count). This is one
pattern for autonomy, not two.

### The run report (single persist input, build + review)

```ts
type RunReport = {
  run: { id: string; mode: 'build' | 'review'; spec: string; commitRange: string; gate: 'green' | 'residual' | 'failed' }
  itemId?: string                               // build mode: the roadmap item this run advanced
  slices: SliceResult[]                         // {id, class, owner, verdict, bounces[]}
  risks: { new: NewRisk[]; dispositions: Disposition[] }
  decisions: Decision[]
  conventions: { id: string; rule: string }[]
  stamps?: { grounding?: ...; partition?: ... }
  modelChange?: { proposedBy: string; reason: string; diff: string }  // vader: parks, never applies
}
```

One report type for both modes. A build tick is a one-item run: `itemId` set, usually one
or few slices. A review run omits `itemId` and partitions the repo.

## Acceptance criteria (each is a contract clause; the gate verifies by file:line)

### CLI

- AC1 `vader init` scaffolds the merged `.vader/` (constitution stub, generated/, spec/,
  runs/, state.json with the merged shape, LEDGER, gate.json, GROUNDING/DECISIONS/CONVENTIONS).
  Idempotent. Detects toolchain for `repoCheck` and detects fallow for `fallowCheck`.
- AC2 `vader gen` compiles the constitution into `generated/checks/` (unchanged router:
  shape/dependency/data/behavioral/rawCheck). Regenerating is clean (old checks removed).
- AC3 `vader gate` runs `repoCheck` + `fallowCheck` (when present) + every generated check
  and returns `{ pass, modelHashLocked, repoCheck, fallow, invariants[] }`. `pass` is
  `modelHashLocked && repoCheck.pass && (fallow?.pass ?? true) && invariants.every(pass)`.
  Fails closed when `modelHashLocked` is false.
- AC4 `vader recall` returns the merged packet: `nextItem` (roadmap), `grounding` and
  `partition` staleness (verify-before-trust), `mustTriage`, `pendingTriage`, `topBounces`,
  `ratchet`, `openRisks`, `pendingModelChange`, `lastRun`, `runCount`. Recall never throws
  on a missing model (bootstrap before P0).
- AC5 `vader triage <risk-id> <finding|defer|close> --reason <text>` records a disposition;
  bare `vader triage` lists open risks. A disposition requires a non-empty reason.
- AC6 `vader persist <report.json>` validates the report, REFUSES (exit 1) if any open risk
  lacks a disposition, appends the ledger (run + bounce lines), advances stamps, applies
  risk dispositions / new risks / decisions / conventions, demotes dirty ratchet classes,
  and: on a `modelChange` parks it and blocks the item (never auto-applies); else on a green
  gate in build mode marks `itemId` done. Rejects duplicate run ids and duplicate risk ids.
- AC7 `vader ratchet [class] [--grant <n> --approved-by <name>]` reports evidence-derived
  autonomy per class and records a human-approved grant only when eligible and named.

### Anti-decay (kept sacred)

- AC8 Owners cannot silence a failure: `vader gate` fails closed when the on-disk model
  hash differs from the locked hash in state. The model and `generated/` are never edited by
  a tick; only a parked, human-approved `modelChange` alters what is enforced.

### Fallow

- AC9 `gate.json` carries an optional `fallowCheck: string[]`. `init` sets it to
  `['fallow','audit','--gate','new-only']` only when a `.fallowrc.json(c)` exists in the
  repo AND a `fallow` binary resolves; otherwise it is absent and the gate skips it (a
  configured-but-failing fallow is a real gate failure, never a silent pass).

### Docs

- AC10 SKILL.md states: two modes (build, review), the two human gates, the parallel
  Workflow fan-out, fallow in the gate, the ponytail fold, and points to the references.
- AC11 `references/acceptance-gate.md` contains the operator's 5-pass independent acceptance
  gate verbatim in intent (role, evidence rule, 5 passes, verdict, invariants), and the
  protocol/recipe name it as the canonical P3 verifier.
- AC12 `references/recipes.md` contains a runnable-shape Workflow script: critic -> seam
  owner alone -> sibling owners in parallel -> cross-assigned refute-first verifiers whose
  voter count scales with `topBounces`; owners run in worktree isolation; the verifier prompt
  IS the acceptance gate.
- AC13 `references/adapters.md` defines the thin adapter contract (drive the CLI; fan out
  via the harness native primitive; sequential fallback where none exists) and documents the
  Claude Code (Workflow) adapter as the Phase 1 working one.
- AC14 The ponytail fold appears as: the Ladder in the owner MANTRA (as an instinct, with
  "deep module" kept as a separate axis, not collapsed into line-count); the `vader:`
  ceiling-comment convention; and a bounded deletion pass available to a verifier.

## Validation to run

- `cd skills/vader/scripts && bun test` (every AC above has a test; reality check, no skips).
- `bunx tsc --noEmit` over `vader.ts` (strict, no any, no unsafe casts).
- Self-check: `bun vader.ts init/gen/gate/recall/persist/triage/ratchet` smoke on a tmp repo.
- Independent acceptance-gate review (subagent that did not write the code) over the diff
  against this contract, looped until ACCEPT.

## Acceptance gate (the operator's, folded in as the canonical P3 verifier)

The full 5-pass gate ships at `references/acceptance-gate.md` and is the prompt every P3
verifier runs. Summary of its law: an independent gate, evidence only (file:line or it did
not happen), five passes (contract conformance differential; divergence/gap bijection; decay
scan; hard-rule lint; fake-green detection), verdict ACCEPT or REJECT on the first line, and
on REJECT an ordered fix list of {file:line, violated clause, exact change}. If no contract
artifact exists, REJECT immediately.

## Invariants (repo core values; the gate rejects on a hit)

- No overall repo architecture decay. No assumptions while planning or coding.
- Deep modules, thin interfaces. Hide complexity behind a small surface.
- Encapsulation over abstraction. Concrete and clear beats clever and generic. No premature
  DRY, no shiny abstraction, no over-split files, no deep nesting.
- Locality of behaviour, low cognitive load. A junior reads it top to bottom.
- One pattern per concern across the repo. Predictable beats novel.
- Clear data models are the backbone. Append-only raw data, idempotency by default.
- Simple, readable, predictable. Functional-first TypeScript, strict, no `any`, no unsafe casts.
- No em dashes and no en dashes anywhere.

## Risks and assumptions

- R1 `vader.ts` grows to roughly one merged module (~950 lines). Accepted with the operator:
  one deep module with a thin CLI, galaxy's own precedent, fewest files, one pattern per
  concern. Not split into two files (that would add a seam where one module belongs).
- R2 The merged state shape differs from the seeded `.vader/state.json` in the MI repo. That
  migration is Phase 2; this phase defines the shape and the MI repo is not touched here.
- R3 Build mode now assembles a full run report per tick (more than the old TickReport). This
  is the cost of giving build mode bounce-memory and ratchet, and the recipe shows the
  assembly. Accepted.
- A1 `bun`, `git`, and (when configured) `fallow` resolve on PATH at the repo root.
- A2 The host provides a fan-out primitive (Workflow) or the adapter falls back to sequential.
