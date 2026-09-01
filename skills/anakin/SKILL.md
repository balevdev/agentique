---
name: anakin
description: Run the ANAKIN software factory — mission command with memory. Turn everyday engineering tasks (tickets, features, hardening) into reviewed diffs by driving the five trooper agents (brainstormer, planner, implementer, verifier, auditor) as an execution pipeline, with all memory in a global SQLite database and zero traces in the repo. Use when the user asks for an anakin run, says "anakin init" or "anakin task", wants a repo built or hardened autonomously, or wants hands-off task-after-task work where the factory never commits and the human reviews each finished task.
---

# ANAKIN — mission command with memory

Turn one approved task into one reviewed diff through one **mission**: a
pipeline of fresh trooper agents (`troopers:brainstormer` … `troopers:auditor`)
dispatched one at a time, with a deterministic gate between implement and
verify. 1 task = 1 mission. Between firings the context is discarded; the
global database at `~/.anakin/anakin.db` is the only memory. The target repo
stays clean: no factory files (the mission dir under `.troopers/` is
gitignored and deleted at close), no commits — ever. The human reviews and
commits each finished task.

## Operating principles

When a situation is not covered below, decide by these, in this order:

1. **Context is finite.** A firing reads a bounded packet: this file, the
   reference for the current phase, and one `recall` call. Commander context
   carries only handoffs; troopers gather their own evidence.
2. **The repo belongs to the human.** No factory commits, no `git add`.
   ANAKIN never edits production code itself — only the implementer trooper
   does, inside its approved scope. The one permitted repo file edit is adding
   `.troopers/` to `.gitignore`. Checkpoints are patches in the journal; the
   tree is the shared workbench and dirty is its normal state.
3. **Troopers build, ANAKIN remembers.** The main context orchestrates,
   metaprompts, runs the gate, and persists every handoff. It writes briefs
   and `00-intel.md`, never solutions. Troopers (the plugin and its repo) are
   never modified.
4. **Determinism beats discipline.** The only thing that blocks a mission is
   the repo's own toolchain, recorded in `gate_commands`. The gate runs in the
   main loop after the implementer, before the verifier; a red gate spawns no
   verifier. Gate rows are read-only during a mission — a gate you edited to
   pass proves nothing.
5. **Budgets are hard stops.** Max 3 gate loops, max 2 verify FAIL loops.
   Exhausted → journal a `stop`, leave the tree as-is, stop for the human.
   Auditor BLOCK → stop, never silently loop.
6. **Ask at intake, never mid-mission.** Questions are cheap during intake and
   poison mid-build. A trooper's genuine blocker is journaled and becomes a
   clean stop.

## Memory — the database and its CLI

All memory lives in `~/.anakin/anakin.db` (every project, one file). The only
read/write path is the CLI next to this skill:

    bun "<this skill's directory>/scripts/anakin-db.ts" <cmd> --repo .

Prose goes through stdin (JSON) or `--patch-file`, never shell-quoted args.
The subcommands: `init`, `recall` (the whole rehydration packet in one call),
`task new|show|approve|close|status`,
`mission open|stage|ingest|close|stop|show`,
`knowledge set|list|stale`, `gate get|set`, `prefs set|list`,
`journal append`, `import` (legacy `.anakin/` folders), `status`
(cross-project; reports missions). `item add|list|check` still exists for
legacy data and `import` — it is history, not the happy path. If a write
fails, the CLI spools the payload to `~/.anakin/spool/` and exits non-zero —
stop cleanly and tell the human.

A read-only dashboard over the same DB ships with the skill
(`scripts/dashboard.ts`; `/anakin dashboard`) — an observatory for the human,
never a write path.

## Phase routing — by DB state

Run `recall --repo .` once and route on its output:

- **`project: null` / no gate commands** → init (recall never registers a
  project; only init does). Read `references/knowledge.md`.
- **No active task** → intake. Read `references/task.md`. (A task submitted by
  the human via `/anakin task <text>` starts here.)
- **Approved or in-progress task** → run the mission. Read
  `references/mission.md`. One firing runs the whole mission — open (or resume
  from the persisted stage cursor), dispatch stages, gate, close.
- **Task in `review`** → the human hasn't committed yet. Stop with the same
  review ask. (When they commit, the next recall flips the task to
  `committed` automatically. The flip keys off HEAD moving at all — an
  unrelated commit also triggers it — so the review ask should say to commit
  this task's diff before other work.)

## Git behavior

Never commit. Never stage. Mission close journals the cumulative task patch
(`git diff <baseline_sha>`) plus `head_sha` and a hash of `git diff HEAD`, so
every checkpoint is recoverable from the DB alone. Human edits to the tree
mid-mission are normal: reconcile them (see mission.md), never revert them.

## Human touchpoints and autonomy

Exactly two: approve the mini-spec + stage plan at intake, and review/commit
the combined diff when the task closes. Between them ANAKIN runs the mission
end to end, stopping itself only when: the mission closes cleanly (→ review),
a budget is exhausted (3 gate loops / 2 verify FAIL loops), the auditor
returns BLOCK, a trooper reports a genuine blocker (journaled first), human
edits conflict with the running mission, or the DB is unreachable (spool
written). A stop is always clean: journal written, tree left as-is, final
message states exactly what is needed to resume. No wakeups while a task sits
in review.

## Requirements

- A git repo (identity, baselines, and patches all come from git).
- `bun` (the CLI runs on it; no npm installs needed).
- The troopers plugin installed — the five agents `troopers:brainstormer`,
  `troopers:planner`, `troopers:implementer`, `troopers:verifier`,
  `troopers:auditor`. If they are unavailable, stop and tell the human —
  never fall back to building in the main context.
- Optional, used when present: `repomap` (knowledge acquisition, impact
  queries), `fallow` (structural gate step). Degrade gracefully when absent.

## What ANAKIN deliberately does not have

No constitution compiler, no fingerprint locks, no bespoke critic agents, no
parallel worktree owners, no voter panels, no autonomy ratchets, no per-harness
adapters, no state files in the repo (the mission dir is gitignored and dies
at close), no task queue, no item slicing. Its predecessors had most of these;
they cost thousands of instruction tokens per step and lost information at
every handoff. ANAKIN keeps what earned its place — deterministic gate first,
rehydrate don't re-derive, one task one mission one diff, triaged stops — and
delegates building to troopers, whose five-stage pipeline it drives but never
modifies.
