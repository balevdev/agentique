# ANAKIN dogfood run 1 — 2026-07-17

Toy repo: tiny ESM cart app (domain/infra split, node:test gate). Flow executed
exactly as the skill files prescribe: init → conceive (approval simulated) →
tick 1 (sensitive money item) → tick 2 (deliberately ambiguous item).

## What was verified

| Check | Result |
|---|---|
| Gate discovered, run at init, green baseline required | pass (`npm test`; a broken test script was fixed pre-init and recorded as a KNOWLEDGE gotcha) |
| Deterministic gate before any LLM review | pass — gate ran and was green before the reviewer was dispatched |
| Sensitive item triggers exactly one refute-first reviewer | pass — reviewer found 2 REAL defects (NaN percent bypassed the range guard; fractional percents misround half-cases). Both fixed; gate rerun green |
| Journal appends one entry per tick | pass |
| Ambiguous item produces a clean journaled stop, no guessing | pass — tick 2 verified "checkout" doesn't exist, journaled the question + two proposed resolutions, committed, stopped |
| Per-tick instruction load | ~2.7k tokens (SKILL.md + commands/anakin.md + references/tick.md = 10,617 chars) |
| Subagent dispatches for the whole run | **1** (the sensitive-item reviewer) vs vader's ~20+ per tick |

## Skill fixes made from dogfood findings

- tick.md journal template asked for the tick's own commit sha, which cannot be
  known before committing. Fixed: the commit containing the journal entry is the
  tick commit; `git log --follow .anakin/JOURNAL.md` maps entries to shas.

## Notes

- The refute-first reviewer paid for itself on the very first money diff — the
  NaN-guard bypass is exactly the class of defect a green test gate does not
  catch. The sensitive-zone trigger is calibrated correctly.
- Conceive's interview was simulated (spec pre-written); the first real run on a
  live repo should exercise the interview path.
