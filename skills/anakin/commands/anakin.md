---
description: Run one step of the ANAKIN software factory (init, task intake, or a single build tick) and self-pace with /loop
---

# /anakin — one step per firing

Read `../SKILL.md` first. Locate the CLI at `../scripts/anakin-db.ts` relative
to this file, run `recall --repo .`, and route by DB state (phase routing in
SKILL.md). Run exactly one step: init, intake, one tick, or task close.

## Pacing

- One tick per firing. Never batch two items into one firing, even small ones —
  the fresh context per item is what keeps quality flat over long runs.
- After a successful tick with todo items remaining: `ScheduleWakeup` (60–120s;
  the DB carries everything forward, there is nothing to wait for).
- On any stop condition from SKILL.md (task closed for review, red gate after
  three attempts, journaled question, conflicting human edits, spooled write):
  do not schedule. End with a message stating what happened and what the human
  should do to resume.

## Arguments

`/anakin` — route by DB state, as above.
`/anakin init` — force (re)initialization: rediscover gate commands, refresh
the knowledge map.
`/anakin task <text>` — start intake with `<text>` as the ask (ticket text,
bug report, or idea). Greenfield ideas get the fuller interview; see
`references/task.md`.
`/anakin harden` — seed a hardening task from audit findings (fallow, gate
runs, review notes) instead of a feature ask; same approval gate.
`/anakin status` — run the CLI `status` and `task status`, report next item,
journal tail, open questions. Read-only, no tick.
`/anakin import` — migrate a legacy committed `.anakin/` directory into the
DB, then remind the human to delete the folder and remove it from git.
`/anakin dashboard` — start the read-only observatory: run
`bun ../scripts/dashboard.ts --open` as a background process, then tell the
human the URL and PID from its startup line
(`anakin dashboard http://127.0.0.1:<port> pid <pid>`) and how to stop it
(`kill <pid>`). Do not schedule wakeups for it; it is not a factory phase.
`--snapshot <file>` instead writes a self-contained HTML snapshot for
sharing. The dashboard opens the DB read-only and can never alter memory.
