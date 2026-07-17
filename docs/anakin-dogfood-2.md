# ANAKIN v2 dogfood run — 2026-07-17

Rehearsal of the SQLite-backed, commitless factory on a scratch bun repo
(2 source files, bun test gate), executed literally per the rewritten skill
files with `ANAKIN_HOME` pointed at a scratch directory. Spec:
`docs/superpowers/specs/2026-07-17-anakin-v2-sqlite-factory-design.md`.

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `bun test` green in `skills/anakin/scripts/` covering identity, lifecycle, recall, journal+spool, import | PASS | 15 tests, 57 assertions, 0 fail |
| 2 | `recall` returns the full packet in one call on a seeded DB | PASS | packet test asserts task, next item, gate, glob-scoped knowledge (+ boundaries always), prefs, journal tail, open questions, FTS hits |
| 3 | Rehearsal init→intake→2 ticks→close with zero repo files and zero factory commits | PASS | `git status --porcelain` showed only ` M` source files after each tick; commit count stayed 3 throughout; `expected_tree_hash` matched `git diff HEAD \| shasum -a 256` at tick-2 recall |
| 4 | Human commit flips the task to `committed`, no false tree warnings | PASS | after `git commit`, recall returned `task: null`, `expected_tree_hash: null`; `task show --id 1` → `committed` |
| 5 | `import` reproduces a v1 `.anakin/` directory in the DB | PASS | gate=1, knowledge=2 (layout+boundary), items=3 (1 done, `sensitive` carried), journal=1 imported note; checked item stayed `done`, next todo was item 2 |
| 6 | Skill markdown references DB/CLI only | PASS | `grep -rn "\.anakin/" skills/anakin/**/*.md` has no hits outside `~/.anakin` and legacy-import wording |

## What the rehearsal exposed

- **Schema fix during Task 3:** `items.journal_id` originally had a foreign
  key to `journal(id)`; with `foreign_keys=ON` a tick could not link an entry
  id it learned from `journal append` output in a separate process without
  ordering constraints, and the planned tests used a soft link. The FK was
  dropped — the journal is append-only, so `journal_id` is a soft pointer.
- **FTS hits exclude the journal tail by design** (they surface *old* memory;
  the last 5 entries are already in the packet). The recall test was adjusted
  to push the searched entry beyond the tail, which is the behavior the
  feature exists for.

## Numbers

- Per-tick instruction load: SKILL.md + commands/anakin.md + tick.md =
  12.3 KB ≈ 3.1k tokens (budget: 4k; v1 was 10.6 KB but read 5 state files —
  v2 replaces those reads with one `recall` call).
- Factory DB round-trips per tick in the rehearsal: 4 CLI calls
  (recall, journal append, item check, task show for baseline).
- Subagent dispatches: 0 (no sensitive items in the rehearsal roadmap).
