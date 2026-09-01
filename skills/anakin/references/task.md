# Intake: ask → mini-spec → stage plan → approval

Goal: a task the human has actually approved — mini-spec plus stage plan —
built from answers rather than assumptions. Questions are cheap here and
poison mid-mission; this is the phase that absorbs them all.

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

Stop interviewing when a competent engineer could start. 1 task = 1 mission —
an ask too big for one mission is split here, at intake, into separate tasks
approved one at a time; never sliced mid-flight.

## The mini-spec

Store via `task new` (stdin JSON: title, description = the raw ask,
mini_spec, stage_plan). The mini-spec, under half a page: purpose, behavior
(input → output, the interesting cases), non-goals (blunt bullets),
acceptance (numbered, each verifiable by the gate, by running the code, or by
reading the diff — "feels fast" is not acceptance).

## The stage plan

A JSON array of stage names, chosen here and approved by the human as part of
the mini-spec. The floor is `implement` + `gate` + `verify` — verification is
never skippable. Pick by the shape of the ask:

| The ask is…                                | stage_plan                                              |
| ------------------------------------------ | ------------------------------------------------------- |
| Trivial and fully specified (typo, config) | `["implement","gate","verify"]`                         |
| A clear ticket — known change, known place | `["plan","implement","gate","verify"]`                  |
| Ambiguous or greenfield — direction unclear| `["brainstorm","plan","implement","gate","verify","audit"]` |

Touches a `sensitive_zone` section → `audit` is mandatory; append it if the
table row above lacks it. When in doubt, add the earlier stages — a wasted
brainstorm is cheaper than an unplanned rewrite. The plan is stored in the
mini_spec (`task new` appends a `stage_plan:` line) and restated verbatim to
`mission open` when the mission starts — `mission open` refuses a plan that
differs from the approved line.

## Sanity pass (inline — no critic agent)

Re-read the spec once: every acceptance criterion is checkable by the gate,
by running the code, or by reading the diff; non-goals actually exclude the
scope creep you fear; the stage plan matches the table and the sensitive-zone
rule; the task fits one mission. Fix what you find.

## The approval gate

Present the mini-spec and the stage plan, then STOP and wait — approval
covers both. On approval: `task approve --id <id>` (records the baseline
HEAD), then `journal append` an `approval` entry ("approved by <name>,
<date>"). If the human answers with edits, treat the edits as the answer and
re-present. Do not open the mission without approval.
