# Tick: one item, one verified diff

You are a fresh context. Everything you need is in the state files; everything
you learn worth keeping goes back into them. Do the steps in order — the order
is the design.

## 1. Recall

Read: `GATE.md`, `ROADMAP.md` (take the first unchecked item), `KNOWLEDGE.md`,
and the last ~5 entries of `JOURNAL.md`. Check the journal tail for unanswered
questions or blocks — if the last entry is a stop waiting on the human and
nothing has changed, stop again with the same ask rather than guessing.

If the working tree has uncommitted changes you didn't make: stop and ask.

## 2. Verify the map where you'll work

If the KNOWLEDGE.md sections covering this item's files have a `verified:` commit
far behind HEAD, or the item enters territory the map doesn't cover, re-check
first — repomap queries or a read-only Explore scout for larger areas. Update
the map and stamps before building. Building on a stale map is how factories
produce confident nonsense.

## 3. Build — in this context

Implement the item yourself. Follow the item's `done-when` and any `contract:`
literally; follow KNOWLEDGE.md conventions; match the surrounding code's style.
Prefer the boring implementation: YAGNI, stdlib before dependency, the smallest
correct change. A new runtime dependency needs a one-line justification in the
journal.

Scouts (read-only subagents) are for reconnaissance you'd otherwise pay a lot of
context for — never for writing code. If mid-build you discover the item is
really two items or contradicts the spec, don't push through: journal it,
propose the roadmap split/change, and stop for the human.

## 4. Gate

Run every command in `GATE.md`. Red → fix and rerun. After three genuinely
different fix attempts on the same failure, stop: journal the exact failing
command and output, leave the tree uncommitted, ask the human. Never satisfy the
gate by weakening it — do not edit `GATE.md`, disable a rule, skip a test, or
loosen a config to get green; that green would be a lie, and lying to the gate
defeats the only deterministic check the factory has.

## 5. Self-review

Read the full diff (`git diff`) fresh, as a reviewer, against three things: the
item's `done-when`, KNOWLEDGE.md's conventions and boundaries, and the spec's
non-goals (did anything creep in?). Fix what you find. Delete anything the diff
added that the item didn't need — dead flags, stray helpers, drive-by edits.

## 6. Independent review — only when marked sensitive

If the item carries `sensitive:` (or the diff unexpectedly touched a sensitive
zone), dispatch exactly one fresh-context reviewer subagent with: the diff, the
item text, and the relevant KNOWLEDGE.md sections. Its brief: *try to refute
this change — find a concrete input or state where it does the wrong thing;
"looks fine" is a failed review only if you genuinely tried.* Fix real findings
and rerun the gate; journal findings you dispute rather than silently dropping
them. Non-sensitive items skip this step — the gate plus self-review is the
calibrated cost for calm code.

## 7. Persist

- Check the item off in `ROADMAP.md`.
- Append one `JOURNAL.md` entry:

  ```
  ## <date> — tick <n>: <item title>
  gate: green (<commands run>)
  review: self [+ independent: <verdict>]
  decisions: <anything a future tick or human needs to know>
  questions: <open questions for the human, or none>
  knowledge: <sections updated, or none>
  ```

- Update KNOWLEDGE.md if the tick taught something durable (see knowledge.md).
- Commit everything — code and `.anakin/` — in one commit with a conventional
  message referencing the item. The commit that introduces a journal entry *is*
  that tick's commit (`git log --follow .anakin/JOURNAL.md` maps entries to
  shas), so the entry never needs to contain its own sha.

## 8. Hand off

Return to `commands/anakin.md` pacing: schedule the next tick, or stop cleanly
on any stop condition, with the journal already telling the human everything.
