---
name: vader
description: Use when building an app autonomously from a spec in any repo root with a /loop-driven software factory, when auditing or hardening an existing repo, when a repo has a .vader/ directory, when the user asks for a vader run or to turn one idea into invariant-checked shipped code, or when architecture must not decay across many agent ticks because a compiled constitution is the protected source of truth.
---

# Vader

An app-agnostic software factory for agentic loops. It builds simple software that values
simplicity, encapsulation, deep modules, and thin interfaces, and it refuses to let
architecture decay across many agent ticks. One idea goes in, or an existing repo comes under
review, and invariant-checked code comes out, built or hardened one slice batch per `/loop`
tick in any repo root.

Core principle: an agent loop is a box with no memory of what it meant. Vader puts the meaning
outside the box. A human-authored `constitution.model` names the semantic distinctions that
must never collapse (a temporal point is not a temporal interval; common must not import etl).
A router compiles each one into the strongest deterministic check the toolchain allows. When an
agent collapses a distinction, the gate fails on a named invariant id. No judgment, no drift.

## Two modes, one engine

- build: idea to shipped code. Conceive (human gate), decompose into disjoint slices, then per
  tick implement one roadmap item and verify it.
- review: audit and harden an existing repo. Ground a fresh baseline, partition the repo into
  disjoint slices, then per tick implement and verify a slice batch.

Both share the same spine: disjoint slices, frozen contracts, refute-first verifiers who never
bless their own work, the compiled-constitution gate, and a triage-gated persist. See
`references/protocol.md`.

## Two human gates, nothing else

1. Freeze the model. The initial SPEC.md plus `constitution.model` is the only approval before
   the build runs. This is conceive (P0).
2. Change the model. Any later change to the constitution is a parked proposal a human
   approves. `vader persist` never auto-applies a model change. Between these two gates the
   factory is fully autonomous: gate the model, free the code.

## Parallel by default

A tick fans out with the harness native primitive (the `Workflow` tool on Claude Code):
critic, then the seam owner alone, then sibling owners in parallel in isolated worktrees, then
cross-assigned refute-first verifiers whose voter count scales with measured bounce history.
The verifier prompt is the acceptance gate. See `references/recipes.md` and
`references/adapters.md`. A host without a fan-out primitive runs the same phases sequentially
and produces the identical report and gate verdict.

## Anti-decay lock

The model is a protected artifact. Implementer agents can make code FAIL the gate but cannot
edit `constitution.model.*`, `generated/`, or `gate.json` to silence a failure. `vader gen`
records two hashes in `state.json`: the compiled model hash, and an enforcement hash over the
compiled surface (every file in `generated/checks/` plus `gate.json`, the command the gate
actually runs). The lock engages when the model is frozen and compiled at P1, and re-freezes
after an approved model change recompiles. If the on-disk model no longer matches its hash, or
any generated check or `gate.json` no longer matches the enforcement hash, `vader gate` fails
closed. Editing the model is a human-gated model-change proposal; editing a generated check or
the verdict config requires a re-`gen`, which is the operator deliberately re-locking the surface
(not a silent agent edit). Neither can be silenced by an implementer.

## Memory that prevents context rot

Vader remembers across ticks so an agent rehydrates instead of re-deriving:

- Verify-before-trust recall. `vader recall` flags every stale layer (grounding and partition
  staleness by commit and watch paths) so nothing stale is trusted silently.
- Triage-gated persist. Every open risk must carry a disposition before a tick can close;
  `vader persist` refuses otherwise, so debt never carries silently.
- Evidence-derived ratchet. Autonomy per class is computed from the ledger (consecutive clean
  runs), never asserted. A dirty run auto-demotes a granted class. `seam`, `security`, and
  `migration` never ratchet.
- Bounce-pattern ledger. Every bounce is recorded; recall surfaces `topBounces` and a repeated
  bounce class scales the next tick's voter count.

## The fallow gate

When a repo carries a `.fallowrc` and `fallow` resolves on PATH, `vader init` wires `fallow
audit --gate new-only` into the gate as a structural step over changed code, the same
ratchet-on-changed-code philosophy the rest of the factory uses. A configured fallow that fails
is a real gate failure, never a silent pass. When fallow is not configured the gate skips it.

## The lazy-senior instinct (folded from ponytail, aligned not worshipped)

Owners carry the Ladder (YAGNI, stdlib, native, dependency-only-if-it-removes-code, smallest
correct implementation) as an instinct in the MANTRA, and name a deliberate simplification with
a `vader:` ceiling comment at the call site. A verifier may run one bounded deletion pass
(complexity only, never a bug fix). Deep module stays a separate axis from line count: when the
Ladder and depth pull against each other, a deep module behind a thin interface wins. Minimalism
over abstraction, because abstraction is dependency.

## CLI surface

Run the bundled zero-dep bun CLI at `scripts/vader.ts` with `--root <repo>`:

- `vader init` scaffolds `.vader/`, detects the toolchain and fallow, and writes `gate.json`.
  Idempotent.
- `vader gen` compiles `constitution.model` into `.vader/generated/checks/` and locks the
  compiled model hash in `state.json`.
- `vader gate` runs the repo check, fallow when configured, and every generated check, and
  prints structured JSON: `pass`, `modelHashLocked`, `enforcementLocked`, `repoCheck`, `fallow`,
  and a per-invariant pass/fail list.
- `vader recall` prints the verify-before-trust rehydration packet (next item, stale layers,
  open risks, `topBounces`, ratchet, parked model change, last run).
- `vader triage <risk-id> <finding|defer|close> --reason <text>` records a risk disposition;
  bare `vader triage` lists open risks.
- `vader persist <run-report.json>` closes a tick: validates the report, refuses on an
  undispositioned open risk, appends the ledger, advances stamps, applies dispositions and new
  risks and decisions and conventions, demotes dirty ratchet classes, and parks a model change
  or marks a build item done.
- `vader ratchet [class] [--grant <level> --approved-by <name>]` reports evidence-derived
  autonomy per class and records a human-approved grant only when eligible and named.

## Requirements

- A git repository (offer `git init` if absent). Slices build in isolated worktrees, and recall
  staleness is measured against commits.
- `bun` on PATH (runtime, test, and zero-dep CLI).
- A fan-out primitive (the `Workflow` tool on Claude Code) for the per-tick owner and verifier
  fan-out, or the sequential fallback.

## How to run a tick

Read `references/protocol.md` for the full phase pipeline, `references/constitution.md` for how
to author the model, `references/recipes.md` for the orchestration script and owner and
verifier prompts, `references/acceptance-gate.md` for the verifier law, and
`references/adapters.md` for the thin per-harness adapter contract. The `/vader` command drives
exactly one tick per `/loop` firing and self-paces with `ScheduleWakeup`.
