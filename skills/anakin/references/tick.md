# Tick: one item, one verified diff, no commit

You are a fresh context. Everything you need is in the recall packet;
everything you learn worth keeping goes back into the DB. Do the steps in
order — the order is the design. `$DB` below means
`bun <skill>/scripts/anakin-db.ts`.

## 1. Recall

`$DB recall --repo .` — one call: task, next item, gate, scoped knowledge,
journal tail, open questions, expected tree state, prefs, and FTS hits from
past ticks ("have we seen this before" — read them, they are free experience).
If the last entry is a stop waiting on the human and nothing has changed, stop
again with the same ask rather than guessing.

## 2. Reconcile the tree

Compute `git diff HEAD | shasum -a 256` and compare with the packet's
`expected_tree_hash` (also check HEAD vs `expected_head_sha`):

- **Hashes match** (or both empty) → proceed.
- **Tree differs** → the human edited mid-task. Read their changes
  (`git diff HEAD`), note them in this tick's journal entry, and continue —
  unless they conflict with the current item, in which case journal the
  conflict and stop cleanly. Never revert human edits.
- **HEAD moved** past `expected_head_sha` → the human committed; recall has
  already reconciled task states. Treat the new HEAD as the new baseline
  reality and re-check staleness.

## 3. Verify the map where you'll work

`$DB knowledge stale --repo . --paths <item files>`. For each stale section:
re-check via repomap or a quick read, `knowledge set` the corrected body with
the new `verified_sha`. Building on a stale map is how factories produce
confident nonsense.

## 4. Build — in this context

Implement the item yourself. Follow its `done_when` and `contract` literally;
follow the packet's conventions and boundaries; match the surrounding code's
style; honor global prefs. Prefer the boring implementation: YAGNI, stdlib
before dependency, the smallest correct change; a new runtime dependency needs
a one-line justification in the journal. Scouts (read-only subagents) are for
reconnaissance you'd otherwise pay a lot of context for — never for writing
code. If mid-build the item turns out to be two items or contradicts the
mini-spec: journal it, propose the split/change, stop for the human.

## 5. Gate

Run every command from the packet's `gate` list, in order. Red → fix and
rerun. After three genuinely different fix attempts on the same failure:
journal a `stop` entry with the exact failing command and output, leave the
tree as-is, stop. Never satisfy the gate by weakening it — no editing gate
rows, disabling rules, skipping tests, or loosening configs; that green would
be a lie.

## 6. Self-review

Read the item's diff fresh, as a reviewer, against three things: `done_when`,
the packet's conventions and boundaries, and the mini-spec's non-goals. Delete
anything the diff added that the item didn't need — dead flags, stray helpers,
drive-by edits.

## 7. Independent review — only when marked sensitive

If the item has `sensitive` set (or the diff unexpectedly touched a
sensitive_zone's paths), dispatch exactly one fresh-context reviewer subagent
with the diff, the item text, and the relevant knowledge sections. Its brief:
*try to refute this change — find a concrete input or state where it does the
wrong thing; "looks fine" is a failed review only if you genuinely tried.*
Fix real findings and rerun the gate; journal findings you dispute rather
than silently dropping them. Non-sensitive items skip this step.

## 8. Persist — no commit

Write the cumulative task patch to a temp file in your scratchpad directory
(never inside the repo): `git diff <task baseline_sha> > <scratchpad>/anakin-patch.diff`.
Then:

1. `$DB journal append --repo . --patch-file <patch>` with stdin JSON:
   `task_id`, `item_id`, `entry_kind: "tick"`, `gate_verdict`, `decisions`
   (anything a future tick or human needs), `questions` (or empty),
   `head_sha` (`git rev-parse HEAD`), `tree_hash`
   (`git diff HEAD | shasum -a 256`, first field).
2. `$DB item check --repo . --id <item> --journal <journal id from step 1>`.
3. `knowledge set` anything durable this tick taught.

The tree keeps all changes uncommitted — that is the design, not an accident.
If the CLI exits non-zero citing a spool file, stop cleanly and tell the human
where the payload is.

## 9. Hand off

Todo items remain → return to `commands/anakin.md` pacing and schedule the
next tick. This was the last item → task close (SKILL.md phase routing): full
gate once more on the whole tree, reviewer-oriented summary of the combined
diff (per item: what changed, why, where), `task close`, journal a `note`
with the summary, stop for human review and commit. Any stop condition → stop
cleanly with the journal already telling the human everything.
