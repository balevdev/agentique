---
name: anakin
description: Run the ANAKIN software factory — turn an approved spec or audit findings into shipped code through small autonomous ticks, one verified diff at a time. Use when the user asks for an anakin run, says "anakin init", wants a repo built or hardened autonomously via /loop, when a repo contains a .anakin/ directory, or when they want an idea taken from interview to spec to roadmap to a sequence of small gated commits without babysitting each one.
---

# ANAKIN — the minimal software factory

Turn one approved spec into shipped code through small, verified, journaled diffs.
One tick = one roadmap item = one reviewable commit. Between ticks the context is
discarded; the committed `.anakin/` files are the only memory.

## Operating principles

These are the reasons behind every rule below. When a situation is not covered,
decide by these, in this order:

1. **Context is finite.** A tick reads a bounded packet: this file, the reference
   for the current phase, and the state files. Nothing else is loaded up front.
   Anything else you need, you go read from the repo when the work demands it.
2. **Knowledge is obtained, not imposed.** ANAKIN learns the repo's real
   architecture into `KNOWLEDGE.md` and keeps it verified against commits. It does
   not invent invariants or install a bespoke enforcement engine. A boundary worth
   enforcing gets encoded in tools someone else maintains — a lint rule, a fallow
   boundary, a real test — proposed as a roadmap item.
3. **Determinism beats discipline.** The only thing that blocks a tick is the
   repo's own toolchain, recorded in `GATE.md`. The gate runs before any LLM
   review; a red gate spawns zero reviewers. Never weaken `GATE.md` to get past a
   red — a gate you edited to pass proves nothing, so treat it as read-only during
   a tick.
4. **The main context builds.** You implement the roadmap item yourself. Subagents
   are read-only scouts for unmapped territory, plus at most one reviewer for
   sensitive diffs. No relay chains: a scout's report feeds your build, it never
   carries the work.
5. **Ask before spec, never mid-tick.** All human questions happen during conceive.
   Mid-tick ambiguity is not a reason to stall or guess big: journal the question,
   stop cleanly, let the human answer between ticks.

## State files — `.anakin/`, committed

| File | Contents | Who writes it |
|---|---|---|
| `KNOWLEDGE.md` | Architecture map learned from the repo: modules, boundaries, conventions, sensitive zones, gotchas. Sections stamped `verified: <commit>`. | ANAKIN, continuously |
| `GATE.md` | The exact shell commands that are the gate (typecheck, lint, tests, fallow). | ANAKIN at init; humans thereafter |
| `SPEC.md` | The approved spec. | ANAKIN drafts, human approves |
| `ROADMAP.md` | Checkbox list of items, each sized for one tick. Features and hardening tasks intermixed. | ANAKIN, human-approved |
| `JOURNAL.md` | Append-only tick log: item, gate verdict, decisions, open questions. | ANAKIN, one entry per tick |

Humans may edit any of these between ticks; the files are the interface.

## Phase routing

Decide the phase from the state on disk, then read only that phase's reference:

- **No `.anakin/` directory** → initialize. Read `references/knowledge.md`.
- **`.anakin/` exists but `SPEC.md` is missing or not approved** → conceive.
  Read `references/conceive.md`; when the spec is agreed, `references/decompose.md`.
- **Approved spec + `ROADMAP.md` with unchecked items** → tick.
  Read `references/tick.md`. This is the steady state.
- **All items checked** → report completion and stop; do not schedule another tick.

## Human gates and autonomy

Exactly one mandatory human gate: approval of `SPEC.md` + `ROADMAP.md` at the end
of conceive. After that ANAKIN runs autonomously tick after tick, stopping itself
only when:

- the roadmap is exhausted,
- the gate stays red after three distinct fix attempts,
- an ambiguity or scope question needs the human (journaled first),
- the repo has uncommitted human changes it did not make (never build on top of a
  dirty tree you don't understand — ask).

A stop is always clean: journal written, tree committed or untouched, the final
message states exactly what is needed to resume.

## Requirements

- A git repo. Every tick ends in a commit; the journal references commits.
- `/loop` (or any recurring driver) for autonomy. A single `/anakin` invocation
  runs exactly one phase step or one tick and is useful on its own.
- Optional, used when present: `repomap` (knowledge acquisition and impact
  queries), `fallow` (structural gate step). Degrade gracefully when absent.

## What ANAKIN deliberately does not have

No constitution compiler, no fingerprint locks, no critic agents, no parallel
worktree owners, no voter panels, no autonomy ratchets, no per-harness adapters.
Its predecessor (vader) had all of these; they cost ~20 subagent dispatches and
~13k instruction tokens per tick and lost information at every handoff. ANAKIN
keeps the parts that earned their place — deterministic gate first, rehydrate
don't re-derive, one item one diff, triaged stops — and deletes the rest.
