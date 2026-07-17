# ANAKIN v2 — global SQLite-backed software factory

Date: 2026-07-17
Status: approved by Boyan (2026-07-17, brainstorming session)

## Purpose

ANAKIN v1 keeps all factory memory in a committed `.anakin/` directory. That
works for personal repos but is unusable in professional repos where the
working tree must stay 100% clean — no factory files, no factory commits, no
traces visible to colleagues. v2 moves all memory to a single global SQLite
database at `~/.anakin/anakin.db`, removes commits from the factory entirely
(the human reviews and commits), and reshapes the unit of work around everyday
professional tasks (one ticket at a time) while keeping greenfield builds as
the same flow with a longer interview.

The discipline that makes ANAKIN work is unchanged: one tick = one verified
diff, deterministic gate before any review, fresh context per tick, rehydrate
don't re-derive, ask-before-spec never mid-tick.

## Decisions (locked during brainstorming)

1. **Nothing in the repo.** No `.anakin/` files even locally; all memory in
   `~/.anakin/`.
2. **Everything in SQLite.** One `~/.anakin/anakin.db` for all projects. No
   markdown state files.
3. **The factory never commits.** Each tick ends with a journaled patch, not a
   commit. The human reviews and commits manually.
4. **Stop after each task.** Ticks run autonomously within a task; when the
   task's items are done and the gate is green, present the combined diff and
   stop for review.
5. **One task at a time.** No task queue. Submit a task, ANAKIN finishes it,
   stops.
6. **Single mode everywhere.** Personal and work repos use the same SQLite
   memory. The committed `.anakin/` mode is retired; a one-time `import`
   migrates legacy directories.
7. **Access via a mini CLI.** A single zero-dependency bun file
   (`scripts/anakin-db.ts`) is the only way ticks read/write memory. It is an
   I/O helper, not an enforcement engine.

## Storage layout

```
~/.anakin/
  anakin.db      # SQLite, WAL mode, busy_timeout set; all projects
  spool/         # fallback: if a DB write fails, the journal entry + patch
                 # are written here as files so a tick never loses work
```

### Schema (tables)

- `projects` — `id` (hash of normalized origin URL; fallback: hash of absolute
  path), `origin_url`, `abs_path`, `name`, `created_at`. Matching on either
  origin URL or path recognizes a moved/re-cloned repo.
- `tasks` — `id`, `project_id`, `title`, `description` (the raw ticket/ask),
  `mini_spec` (purpose, behavior, non-goals, acceptance), `status`:
  `draft → approved → in_progress → review → committed`, timestamps.
- `items` — `id`, `task_id`, `ordinal`, `title`, `files` (expected paths),
  `done_when`, `contract` (nullable), `sensitive` (nullable zone name),
  `status`: `todo | done`, `journal_id` (nullable, set on completion).
- `knowledge_sections` — `id`, `project_id`, `kind`
  (`layout | boundary | convention | sensitive_zone | gotcha`), `title`,
  `body`, `paths_glob` (comma-separated globs the section covers),
  `verified_sha`, `updated_at`.
- `journal` — `id`, `project_id`, `task_id`, `item_id` (nullable for
  non-tick entries like approvals/stops), `entry_kind`
  (`tick | approval | stop | note`), `gate_verdict`, `decisions`, `questions`,
  `patch` (full `git diff` vs the task's baseline HEAD), `head_sha`,
  `tree_hash` (hash of the post-tick `git diff HEAD` output), `created_at`.
  Plus an FTS5 virtual table over `decisions`, `questions`, and item titles.
- `gate_commands` — `project_id`, `ordinal`, `command`, `reason`. Read-only
  during a tick, exactly like GATE.md was.
- `prefs` — global cross-project conventions (`key`, `body`): the user's
  standing preferences (stdlib-first, dependency policy, style instincts).
  Included in every recall packet for every project.

Retention: journal metadata is kept forever; `patch` bodies may be pruned for
tasks older than the last 20 `committed` tasks per project (metadata stays).

## Access layer — `scripts/anakin-db.ts`

Single bun file, zero npm dependencies (`bun:sqlite`). Prose arrives via stdin
or `--file`, never through shell-quoted arguments. Subcommands:

- `init --repo <path>` — create DB if absent, register/recognize the project.
- `recall --repo <path>` — print the full tick rehydration packet as JSON:
  active task + next todo item, gate commands, knowledge sections whose
  `paths_glob` intersects the item's `files` (plus all `boundary` and
  `sensitive_zone` sections), last 5 journal entries, open questions, the
  expected `tree_hash` from the last entry, global prefs, and FTS hits for the
  item's title/text ("have we seen this before").
- `task new|show|approve|close|status` — task lifecycle.
- `item add|check|list` — tick items.
- `knowledge set|get|list|stale --paths <globs>` — sections; `stale` lists
  sections whose `verified_sha` is behind HEAD for the given paths.
- `journal append` — one entry (JSON on stdin, patch via `--patch-file`).
- `gate get|set` — gate commands.
- `import --repo <path>` — one-time migration of a legacy `.anakin/`
  directory into the DB; on success instruct the human to delete the folder.
- `status` — cross-project overview (all projects, active tasks, last ticks).

On any DB write failure the CLI writes the payload to `~/.anakin/spool/` and
exits non-zero with the spool path; the tick stops cleanly citing it.

## Workflow

### Phases (routed by DB state, not disk state)

- Project unknown to DB → **init**: discover gate commands, run gate once
  (red baseline → report and stop), map architecture into
  `knowledge_sections`. Same content rules as v1 `knowledge.md`.
- No active task → **intake**: the human submits a task (ticket text or
  idea). ANAKIN reads the map, asks questions ONLY on real ambiguity (a few,
  multiple-choice preferred; greenfield ideas get the fuller v1-style
  interview — same phase, longer), writes `mini_spec` + items (v1 decompose
  sizing/ordering rules apply verbatim), presents both, waits for one
  approval. Approval is journaled (`entry_kind: approval`).
- Approved task with todo items → **tick** (steady state).
- All items done → **task close**: run the gate once more on the whole tree,
  present a reviewer-oriented summary of the combined diff (per-item map of
  what changed and why), set task `status: review`, stop. The human reviews,
  commits however they like; the next recall detects the new HEAD and flips
  the task to `committed`.

### One tick

1. **Recall** — one `anakin-db recall` call. If the last entry is a stop
   waiting on the human and nothing changed, stop again with the same ask.
2. **Reconcile the tree** — compute `git diff HEAD`; compare its hash with
   the expected `tree_hash`. Mismatch = the human edited mid-task: read the
   human's changes, note them in the journal, continue — or stop and ask if
   they conflict with the current item. If HEAD moved past the recorded
   `head_sha`, mark reviewable work committed and re-check staleness.
   (The v1 rule "dirty tree → stop" is retired: dirty is the normal state.)
3. **Verify the map** — if relevant sections are stale (`knowledge stale`),
   re-check via repomap or a read-only Explore scout, update sections and
   `verified_sha` first.
4. **Build** — in the main context, exactly as v1 tick.md: follow
   `done_when` and `contract`, boring implementation, scouts read-only, split
   the item via journal + stop if it turns out to be two items.
5. **Gate** — run every `gate_commands` row. Red → fix and rerun; three
   distinct failed attempts → journal the failure (`entry_kind: stop`), leave
   the tree as-is, stop. Never weaken the gate; gate rows are read-only
   during a tick.
6. **Self-review** — read the item's diff fresh against `done_when`,
   conventions/boundaries, and the task's non-goals; delete creep.
7. **Independent review** — only for `sensitive` items (or diffs that
   unexpectedly touch a sensitive zone): one fresh-context refute-first
   reviewer subagent, as in v1.
8. **Persist** — `item check` + `journal append` with the cumulative task
   patch, `head_sha`, `tree_hash`, decisions, questions, knowledge updates.
   No commit, ever.
9. **Hand off** — more todo items → `ScheduleWakeup` (60–120s); last item →
   task close; any stop condition → clean stop with the journal already
   telling the human everything.

### Stop conditions (unchanged in spirit)

Roadmap-of-task exhausted (→ task close), red gate after three distinct
attempts, journaled ambiguity, human edits that conflict with the current
item, DB unreachable (spool written).

## Memory improvements over v1

1. **Scoped staleness** — knowledge is per-section with `paths_glob`; only
   the map where the tick steps is verified, not the whole file.
2. **Searchable journal** — FTS5 recall surfaces past decisions, repeated
   failures, and gotchas relevant to the current item automatically,
   including the fact that they exist at all (v1 read only the last 5
   entries and nothing else, ever).
3. **Global prefs** — the user's standing conventions apply in every project
   from day 0 instead of being re-derived per repo.
4. **Bounded reads at any scale** — last-5 journal entries is one indexed
   query whether the project has 50 or 5000 ticks.
5. **Patches as checkpoints** — every tick's exact diff is recoverable
   forever, independent of git history, enabling rollback ("re-apply patches
   up to tick N") and post-hoc review of any tick.

## Skill changes

- `skills/anakin/SKILL.md` — rewrite: state section (DB + CLI instead of
  five files), phase routing by DB state, git behavior (never commit),
  requirements (git repo, bun; repomap/fallow still optional).
- `references/conceive.md` + `references/decompose.md` → merged into
  `references/task.md` (intake: light for tickets, full interview for
  greenfield; sizing/ordering rules carried over verbatim).
- `references/knowledge.md` — rewrite for `knowledge_sections` rows and
  `gate_commands`; same content principles (learned not invented, checkable
  claims, mechanize-what-deserves-it items).
- `references/tick.md` — rewrite per the tick above.
- `commands/anakin.md` — rewrite: `/anakin` routes by DB state; `/anakin
  init`, `/anakin task <text>`, `/anakin status` (uses CLI `status`),
  `/anakin harden` seeds a hardening task; pacing unchanged.
- New: `scripts/anakin-db.ts`, `scripts/schema.sql`, `scripts/anakin-db.test.ts`
  (bun test), `scripts/package.json` (no runtime deps).

## Non-goals

- No task queue, no multi-task parallelism, no per-tick human review mode.
- No sync/export between machines in v2 (future: `anakin export/import`).
- No re-introduction of vader machinery (constitution, ratchets, voter
  panels, worktree owners).
- No changes to vader itself.

## Acceptance

1. `bun test` in `skills/anakin/scripts/` is green; tests cover project
   identity (origin URL + moved path), task lifecycle, recall packet
   contents (scoped knowledge, FTS hits, prefs), journal append + spool
   fallback, and legacy import.
2. `anakin-db recall` returns the full packet in one call on a seeded DB.
3. A rehearsal run on a scratch git repo completes init → intake → 2 ticks →
   task close with zero files created inside the repo and zero commits made
   by the factory.
4. After a human commit, the next recall flips the task to `committed` and
   reports no false "human edited the tree" warnings.
5. `import` on a repo with a v1 `.anakin/` directory reproduces its state in
   the DB (gate commands, knowledge sections, roadmap items, journal tail).
6. All skill markdown references the DB/CLI only — no mention of committed
   state files remains.
