---
description: Run one step of the ANAKIN software factory (init, conceive, or a single build tick) and self-pace with /loop
---

# /anakin — one step per firing

Read `../SKILL.md` first. Then decide the phase from `.anakin/` state on disk
(phase routing in SKILL.md) and run exactly one step:

- **init** → build `GATE.md` and `KNOWLEDGE.md` per `references/knowledge.md`, then stop.
- **conceive** → interview, draft `SPEC.md` and `ROADMAP.md` per
  `references/conceive.md` + `references/decompose.md`, then stop for approval.
- **tick** → execute exactly one roadmap item per `references/tick.md`.

## Pacing

- One tick per firing. Never batch two roadmap items into one firing, even small
  ones — the fresh context per item is what keeps quality flat over long runs.
- After a successful tick with unchecked items remaining: `ScheduleWakeup`
  (60–120s; the state files carry everything forward, there is nothing to wait for).
- On any stop condition from SKILL.md (roadmap done, red gate after three
  attempts, journaled question, dirty tree): do not schedule. End with a message
  stating what happened and what the human should do to resume.

## Arguments

`/anakin` — route by state, as above.
`/anakin init` — force (re)initialization, refreshing GATE.md and KNOWLEDGE.md.
`/anakin harden` — seed or extend ROADMAP.md from audit findings (fallow, gate
runs, review notes) instead of a feature spec; still passes the approval gate.
`/anakin status` — read the state files and report: next item, journal tail,
open questions, gate health. Read-only, no tick.
