---
description: Run one phase of the ANAKIN software factory (init, task intake, or one whole trooper mission end to end)
---

# /anakin — one firing, one phase

Read `../SKILL.md` first. Locate the CLI at `../scripts/anakin-db.ts` relative
to this file, run `recall --repo .`, and route by DB state (phase routing in
SKILL.md). One firing runs exactly one of: init, intake, **one whole mission**
end to end, or status.

## Pacing

- A mission runs start to finish in one firing: open (or resume from the
  persisted stage cursor), dispatch troopers one at a time, gate, close.
  Every handoff is persisted the moment it lands, so an interrupt resumes
  from the cursor — never from memory.
- After a clean close the task sits in `review`: end the turn with the review
  ask (what to look at, how to commit). No `ScheduleWakeup` while waiting on
  the human — the factory stops between tasks by design.
- On any stop condition from SKILL.md (budgets exhausted, auditor BLOCK,
  trooper blocker, conflicting human edits, spooled write): do not schedule.
  End with a message stating what happened and what the human should do to
  resume.

## Arguments

`/anakin` — route by DB state, as above.
`/anakin init` — force (re)initialization: rediscover gate commands, refresh
the knowledge map.
`/anakin task <text>` — start intake with `<text>` as the ask (ticket text,
bug report, or idea). Greenfield ideas get the fuller interview and the
longer stage plan; see `references/task.md`.
`/anakin harden` — seed a hardening task from audit findings (fallow, gate
runs, review notes) instead of a feature ask; same approval gate.
`/anakin status` — run the CLI `status` and `task status`, report the active
mission (stage plan, cursor, latest handoffs), journal tail, open questions.
Read-only, no mission.
`/anakin import` — migrate a legacy committed `.anakin/` directory into the
DB, then remind the human to delete the folder and remove it from git.
`/anakin dashboard` — start the read-only observatory: run
`bun ../scripts/dashboard.ts --open` as a background process, then tell the
human the URL and PID from its startup line
(`anakin dashboard http://127.0.0.1:<port> pid <pid>`) and how to stop it
(`kill <pid>`). Do not schedule wakeups for it; it is not a factory phase.
`--snapshot <file>` instead writes a self-contained HTML snapshot for
sharing. The dashboard opens the DB read-only and can never alter memory.
