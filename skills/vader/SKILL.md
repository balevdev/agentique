---
name: vader
description: Use when building an app autonomously from a spec in any repo root with a /loop-driven software factory, when a repo has a .vader/ directory, when the user asks for a vader run or to turn one idea into invariant-checked shipped code, or when architecture must not decay across many agent ticks because a compiled constitution is the protected source of truth.
---

# Vader

An app-agnostic software factory for agentic loops. One idea goes in. A deep spec, a
protected constitution, a roadmap of disjoint slices, and shipped code come out, built one
roadmap item per `/loop` tick in any repo root, with no architecture decay.

Core principle: an agent loop is a box with no memory of what it meant. Vader puts the
meaning outside the box. A human-authored `constitution.model` names the semantic
distinctions that must never collapse (a temporal point is not a temporal interval; common
must not import etl). A router compiles each one into the strongest deterministic check the
target toolchain allows. When an agent collapses a distinction, the gate fails on a named
invariant id. No judgment, no drift.

## The loop

```
vader init (once per repo) -> vader recall -> conceive (idea -> SPEC.md -> constitution model, HUMAN GATE)
   -> decompose (roadmap of disjoint slices, frozen contracts, vader gen)
   -> per /loop tick: implement one item (Workflow owners, worktree isolation)
   -> verify (refute-first verifiers + vader gate; a failed invariant id is an automatic bounce)
   -> vader persist (model changes parked for the human gate) -> next tick rehydrates from recall
```

Two human gates, nothing else:

1. **Freeze the model.** The initial SPEC.md plus `constitution.model` is the only
   approval before the build runs. This is conceive (P0).
2. **Change the model.** Any later change to the constitution is a parked proposal a human
   approves. `vader persist` never auto-applies a model change. Between these two gates the
   factory is fully autonomous: gate the model, free the code.

## Anti-decay lock

The model is a protected artifact. Implementer agents can make code FAIL the gate but
cannot edit `constitution.model.*` or `generated/` to silence a failure. `vader init`
records the model hash in `state.json`; if the on-disk model no longer matches the locked
hash, `vader gate` fails closed. The only way to change what is enforced is a human-gated
model-change proposal.

## CLI surface

Run the bundled zero-dep bun CLI at `scripts/vader.ts`:

- `vader init --root <repo>` scaffolds `.vader/`, detects the repo toolchain, writes a stub
  gate, and locks the model hash. Idempotent.
- `vader gen --root <repo>` compiles `constitution.model` into `.vader/generated/checks/`.
- `vader gate --root <repo>` runs the repo check plus every generated check and prints
  structured JSON: `pass`, `modelHashLocked`, and a per-invariant pass/fail list.
- `vader recall --root <repo>` prints state for the next tick (roadmap, next item, any
  parked model change).
- `vader persist --root <repo>` records a tick outcome: marks the item done on a green gate,
  blocks it and parks a model-change proposal otherwise.

## Requirements

- A git repository (offer `git init` if absent). Slices build in isolated worktrees.
- `bun` on PATH (runtime, test, and zero-dep CLI).
- The `Workflow` tool for the per-tick owner/verifier fan-out.

## How to run a tick

Read `references/protocol.md` for the full phase pipeline and `references/constitution.md`
for how to author the model. The `/vader` command drives exactly one tick per `/loop`
firing and self-paces with `ScheduleWakeup`.
