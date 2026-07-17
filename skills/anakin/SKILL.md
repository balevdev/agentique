---
name: anakin
description: Run the ANAKIN software factory — turn everyday engineering tasks (tickets, features, hardening) into reviewed diffs through small autonomous ticks, with all memory in a global SQLite database and zero traces in the repo. Use when the user asks for an anakin run, says "anakin init" or "anakin task", wants a repo built or hardened autonomously via /loop, or wants hands-off task-after-task work where the factory never commits and the human reviews each finished task.
---

# ANAKIN — the minimal software factory

Turn one approved task into one reviewed diff through small, verified,
journaled ticks. One tick = one item = one verified diff. Between ticks the
context is discarded; the global database at `~/.anakin/anakin.db` is the only
memory. The target repo stays 100% clean: the factory creates no files in it
and makes no commits — ever. The human reviews and commits each finished task.

## Operating principles

When a situation is not covered below, decide by these, in this order:

1. **Context is finite.** A tick reads a bounded packet: this file, the
   reference for the current phase, and one `recall` call. Anything else you
   need, you go read from the repo when the work demands it.
2. **The repo belongs to the human.** No factory files inside it, no factory
   commits, no `git add`. Checkpoints are patches in the journal; the tree is
   the shared workbench and dirty is its normal state.
3. **Knowledge is obtained, not imposed.** ANAKIN learns the repo's real
   architecture into `knowledge_sections` rows and keeps them verified against
   commits. A boundary worth enforcing gets encoded in tools someone else
   maintains — a lint rule, a fallow boundary, a real test — proposed as a
   task item, never as a bespoke engine.
4. **Determinism beats discipline.** The only thing that blocks a tick is the
   repo's own toolchain, recorded in `gate_commands`. The gate runs before any
   LLM review; a red gate spawns zero reviewers. Gate rows are read-only
   during a tick — a gate you edited to pass proves nothing.
5. **The main context builds.** Subagents are read-only scouts for unmapped
   territory, plus at most one reviewer for sensitive diffs. No relay chains.
6. **Ask at intake, never mid-tick.** Questions are cheap during intake and
   poison mid-build. Mid-tick ambiguity is journaled and becomes a clean stop.

## Memory — the database and its CLI

All memory lives in `~/.anakin/anakin.db` (every project, one file). The only
read/write path is the CLI next to this skill:

    bun "<this skill's directory>/scripts/anakin-db.ts" <cmd> --repo .

Prose goes through stdin (JSON) or `--patch-file`, never shell-quoted args.
The subcommands: `init`, `recall` (the whole rehydration packet in one call),
`task new|show|approve|close|status`, `item add|list|check`,
`knowledge set|list|stale`, `gate get|set`, `prefs set|list`,
`journal append`, `import` (legacy `.anakin/` folders), `status`
(cross-project). If a write fails, the CLI spools the payload to
`~/.anakin/spool/` and exits non-zero — stop cleanly and tell the human.

A read-only dashboard over the same DB ships with the skill
(`scripts/dashboard.ts`; `/anakin dashboard`) — an observatory for the human,
never a write path.

## Phase routing — by DB state

Run `recall --repo .` once and route on its output:

- **Project unknown / no gate commands** → init. Read `references/knowledge.md`.
- **No active task** → intake. Read `references/task.md`. (A task submitted by
  the human via `/anakin task <text>` starts here.)
- **Active task with todo items** → tick. Read `references/tick.md`. Steady state.
- **Active task, all items done** → close: run the full gate once on the whole
  tree, write a reviewer-oriented summary of the combined diff (per-item map of
  what changed and why), `task close`, journal it, stop for human review.
- **Task in `review`** → the human hasn't committed yet. Stop with the same
  ask. (When they commit, the next recall flips the task to `committed`
  automatically.)

## Git behavior

Never commit. Never stage. Each tick ends by journaling the cumulative task
patch (`git diff <baseline_sha>`) plus `head_sha` and a hash of `git diff
HEAD`, so every checkpoint is recoverable from the DB alone. Human edits to
the tree mid-task are normal: reconcile them (see tick.md), never revert them.

## Human touchpoints and autonomy

Exactly two: approve the mini-spec + items at intake, and review/commit the
combined diff when the task closes. Between them ANAKIN runs tick after tick,
stopping itself only when: the task's items are exhausted (→ close), the gate
stays red after three distinct fix attempts, an ambiguity needs the human
(journaled first), human edits conflict with the current item, or the DB is
unreachable (spool written). A stop is always clean: journal written, tree
left as-is, final message states exactly what is needed to resume.

## Requirements

- A git repo (identity, baselines, and patches all come from git).
- `bun` (the CLI runs on it; no npm installs needed).
- `/loop` (or any recurring driver) for autonomy; a single `/anakin` firing
  runs one phase step and is useful on its own.
- Optional, used when present: `repomap` (knowledge acquisition, impact
  queries), `fallow` (structural gate step). Degrade gracefully when absent.

## What ANAKIN deliberately does not have

No constitution compiler, no fingerprint locks, no critic agents, no parallel
worktree owners, no voter panels, no autonomy ratchets, no per-harness
adapters, no state files in the repo, no task queue. Its predecessor (vader)
had the first seven; they cost ~20 subagent dispatches and ~13k instruction
tokens per tick and lost information at every handoff. ANAKIN keeps what
earned its place — deterministic gate first, rehydrate don't re-derive, one
item one diff, triaged stops — and deletes the rest.
