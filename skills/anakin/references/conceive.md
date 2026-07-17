# Conceive: interview → spec → human gate

Goal: a `SPEC.md` the human has actually approved, built from answers rather than
assumptions. This is the one phase where questions are cheap and mandatory —
every question asked here is ten not asked mid-build, and mid-build is where
wrong guesses become wrong code.

## The interview

Read `KNOWLEDGE.md` first so questions come from someone who knows the repo.
Then interview the human about the idea. One question at a time, multiple-choice
where possible, and each question earns its place — skip what the idea statement
or the repo already answers. Cover, in roughly this order:

1. **Purpose** — what problem, for whom, and what does done look like?
2. **Scope and non-goals** — what is explicitly out? (The cheapest place to kill
   scope creep is here, in writing.)
3. **Constraints** — performance, compatibility, deadlines, things that must not
   change.
4. **Sensitive contact** — does this touch anything in KNOWLEDGE.md's sensitive
   zones? If yes, confirm expected behavior there explicitly; those answers
   become acceptance criteria.
5. **Success criteria** — observable checks a reviewer could run, not adjectives.

Stop interviewing when a competent engineer could start; don't interrogate past
that point.

## SPEC.md

Write the spec from the answers. Keep it under a page:

```
# <Title>
## Purpose        — 2–4 sentences, includes who it's for
## Behavior       — what it does, input → output, the interesting cases
## Non-goals      — bulleted, blunt
## Constraints    — bulleted
## Acceptance     — numbered, each one checkable
```

Every acceptance item must be verifiable by the gate, by running the code, or by
reading the diff. "Feels fast" is not acceptance; "list renders under 200ms with
1k rows" is.

## The gate

Continue into `references/decompose.md` to produce `ROADMAP.md`, then present
both files and stop for approval. This is ANAKIN's single mandatory human gate:
do not begin the first tick until the human has approved, and record the
approval as the first `JOURNAL.md` entry ("spec approved by <name>, <date>").
If the human edits the files instead of saying yes, treat the edits as the
answer and re-present.
