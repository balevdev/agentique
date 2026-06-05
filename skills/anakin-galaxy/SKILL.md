---
name: anakin-galaxy
description: Use when running a long-horizon software factory over a repo - repeated multi-agent build or review sprints that must not degrade across runs, when a repo has a .galaxy/ directory, when the user asks for a factory run, a galaxy run, spec-to-shipped-code with memory, or when prior sprint learnings (risks, decisions, bounce patterns, proven partitions) must feed the next sprint.
---

# Anakin Galaxy

A software factory: repeated agent sprints over one repo where every run's output is the
next run's mandatory input. Within a run it is the Anakin sprint shape (ground, slice,
frozen contracts, parallel owners, adversarial cross-verifiers, two-sided gate). Between
runs a deterministic CLI closes the loop so the factory learns instead of degrading.

Core principle: slop is the gap between what you meant and what you checked. The factory
controls everything expressible as a checkable acceptance criterion, and its memory makes
the checked surface grow run over run.

## The loop

```
galaxy init (once per repo) -> galaxy recall -> triage risks -> ground (fresh baseline)
   -> compile spec to contracts -> human approves contracts
   -> Workflow fan-out (owners, then verifiers) -> session gate
   -> galaxy persist -> next run rehydrates from recall
```

Three hard rules, mechanically backed:

1. **Recall first.** Phase -1 of every run is `galaxy recall`. Anything flagged stale is
   verified before it is trusted, never silently applied.
2. **Persist always.** A run that did not `galaxy persist` is a failed run. Persist
   refuses (exit 1) while any open risk lacks a disposition, so debt cannot silently
   carry over.
3. **Nobody verifies their own work.** Owners hold disjoint slices; no owner's work is
   accepted without an independent verifier that did not write it, refute-first,
   defaulting to bounce. In the Workflow runtime independence is structural (each
   verifier is a fresh agent); in runtimes where agents persist, cross-assign.

## Requirements

- A git repo. Factory state lives in `.galaxy/` at the repo root, committed.
- bun (runs the CLI). Claude Code with the Workflow tool for the fan-out; without it,
  fall back to hand-spawned agents in the same phase order.

## The CLI

```
GALAXY="bun <this-skill-dir>/scripts/galaxy.ts"
$GALAXY init                                # create .galaxy/ (idempotent)
$GALAXY recall                              # the rehydration packet (JSON)
$GALAXY triage <risk-id> <finding|defer|close> --reason "..."
$GALAXY persist <run-report.json>           # close the loop; gates on triage
$GALAXY ratchet [class] [--grant <n> --approved-by <name>]
```

All commands accept `--root <dir>` and print JSON. Errors go to stderr with exit 1.
The CLI owns `state.json` and `LEDGER.jsonl`; never hand-edit them. The session owns
the prose files and `runs/<id>/`.

## Reference files

- `references/protocol.md`: phases -1 to 5, the one invariant, the session vs workflow
  vs CLI split, the gate. Read this first for any run.
- `references/memory.md`: the `.galaxy/` layout, the run-report schema persist consumes,
  staleness semantics, and how to seed history.
- `references/ratchet.md`: autonomy levels, the evidence that licenses them, automatic
  demotion. Advisory only; it never acts.
- `references/recipes.md`: the workflow script idioms, including bounce-pattern
  injection and evidence-scaled verifier voters.

## Known limits (by design)

- The capability boundary is the checkable-AC boundary; taste stays human.
- The ratchet ships dormant: it cannot license autonomy until real runs accrue evidence.
- Memory can fossilize; the stamps and verify-before-trust rule are load-bearing.
