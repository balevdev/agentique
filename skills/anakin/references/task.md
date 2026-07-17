# Intake: ask → mini-spec → items → approval

Goal: a task the human has actually approved — mini-spec plus one-tick items —
built from answers rather than assumptions. Questions are cheap here and
poison mid-build; this is the phase that absorbs them all.

## Scale the interview to the ask

Read the recall packet's knowledge sections first so questions come from
someone who knows the repo. Then:

- **A ticket or small ask** — most days. Ask ONLY on real ambiguity: a few
  questions, multiple-choice preferred, skip everything the ticket or the repo
  already answers. Often zero questions is correct.
- **A greenfield idea** — the fuller interview, one question at a time:
  purpose (what problem, for whom, what does done look like), scope and
  non-goals (the cheapest place to kill scope creep), constraints, sensitive
  contact (does this touch a sensitive_zone section? confirmed behavior there
  becomes acceptance), success criteria (observable checks, not adjectives).

Stop interviewing when a competent engineer could start.

## The mini-spec

Store via `task new` (stdin JSON: title, description = the raw ask,
mini_spec). The mini-spec, under half a page: purpose, behavior
(input → output, the interesting cases), non-goals (blunt bullets),
acceptance (numbered, each verifiable by the gate, by running the code, or by
reading the diff — "feels fast" is not acceptance).

## Items — one tick each

Add via `item add` (stdin JSON: ordinal, title, files, done_when, contract?,
sensitive?). An item is right-sized when ALL of these hold:

- **One concern.** One module or one behavior. If describing it needs "and", cut it.
- **One diff reviewable in ~5 minutes.** One endpoint, one component, one
  migration, one refactor of one file cluster.
- **Completable in one fresh context.** The implementer holds the item, its
  files, and the knowledge sections — nothing more.
- **Gate-checkable on its own.** After the item the gate is green and something
  new demonstrably works. No item may leave the tree red for the next one.

Ordering:

- **Contracts before consumers.** Shared interfaces are defined by the first
  item, frozen in its `contract` field, so later items build against something
  settled — not a guess.
- **Risk early.** Sensitive/unknown items go first, while the human is paying
  the most attention and the least is stacked on top.
- **Each item leaves the tree shippable** (gate green), so stopping after any
  item leaves working software plus a clean patch.

`done_when` is the tick's exit test; write it so the implementer cannot
mis-guess intent. Mark `sensitive` explicitly (copy the zone name from the
knowledge section) — the tick uses it to decide whether to pay for an
independent review. Hardening items (from init's mechanization proposals,
fallow findings, `/anakin harden`) use the same shape and the same list.

## Sanity pass (inline — no critic agent)

Re-read the items once: disjoint (no two items edit the same file for the same
reason), contracts defined before used, every acceptance criterion covered by
some item's done_when, no item secretly two items. Fix what you find.

## The approval gate

Present the mini-spec and items, then STOP and wait. On approval:
`task approve --id <id>` (records the baseline HEAD), then
`journal append` an `approval` entry ("approved by <name>, <date>"). If the
human answers with edits, treat the edits as the answer and re-present. Do not
start the first tick without approval.
