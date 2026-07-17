# ANAKIN Dashboard — Design

Date: 2026-07-17
Status: approved
Depends on: `2026-07-17-anakin-v2-sqlite-factory-design.md` (shipped, ef53ce8..db6bf5d)

## Goal

A read-only observatory over the anakin factory memory (`~/.anakin/anakin.db`),
shipped inside the skill as plain HTML/CSS/TS, served locally by a bun script
with zero npm dependencies. You open it to see what the factory has done and is
doing — stats, tasks, journal, knowledge — with minimal, senior-level UX. It
never writes to the DB and never touches target repos.

## Non-goals

- No writes of any kind: no approving tasks, no answering questions, no
  spawning/killing factory work from the browser. All writes stay in
  `anakin-db.ts`. ("Spawn/kill" applies to the dashboard server process only.)
- No framework, no bundler artifacts committed, no npm dependencies.
- No auth (binds `127.0.0.1` only; the DB is the user's own local memory).
- No pixel-level UI tests.

## Architecture

New files, all under `skills/anakin/scripts/`:

```
dashboard.ts              # server + snapshot generator (bun, zero deps)
dashboard/index.html      # shell
dashboard/style.css       # the whole visual system
dashboard/app.ts          # hash router + fetch + render (transpiled by Bun.build at startup, in memory)
dashboard.test.ts         # bun test, same harness style as anakin-db.test.ts
```

`anakin-db.ts` is not modified. `dashboard.ts` opens the DB itself with
`new Database(path, { readonly: true })` — the dashboard is structurally unable
to corrupt factory state. `ANAKIN_HOME` overrides the home directory exactly as
in the CLI. If the DB file does not exist, the server still starts and every
API returns an `empty: true` payload (the UI shows the empty state; it does not
create the DB).

### CLI

`bun skills/anakin/scripts/dashboard.ts [flags]`

- `--port <n>` — default 4600; if taken, fail with a clear message (no auto-scan).
- `--open` — open the system browser at the URL after listening.
- `--snapshot [file]` — do not serve; write one self-contained HTML file
  (CSS + transpiled JS + all data inlined as `window.__SNAPSHOT__`) to the
  given path (default `./anakin-dashboard.html`) and exit 0. In snapshot mode
  the UI disables polling and search runs client-side over the inlined data.
- On start (serve mode) print exactly one line the human and the skill can
  parse: `anakin dashboard http://127.0.0.1:<port> pid <pid>`.
- Stop: Ctrl+C / `kill <pid>`. No daemon management.

### Skill integration

- `commands/anakin.md` gains a `dashboard` arg: `/anakin dashboard` runs the
  server in the background (`run_in_background`), reports the URL and the kill
  command to the human, and does not schedule further wakeups for it.
- `SKILL.md` mentions the dashboard in one line under requirements/phases
  (read-only observatory; optional).

### HTTP surface (GET only, JSON unless noted)

- `/` → `index.html`; `/style.css`; `/app.js` (the in-memory `Bun.build`
  output of `app.ts`).
- `/api/overview` → `{ projects: [{id, name, root_path, active_task,
  items_done, items_total, last_activity, open_questions}], totals: {projects,
  tasks_by_status, ticks_7d, ticks_30d_by_day, open_questions}, recent:
  [journal entries, newest 20 across projects], questions: [open questions
  across projects with project + task context] }`.
- `/api/project/:id` → `{ project, prefs, task (active or latest), items,
  gate, knowledge (all sections, with verified_sha + updated_at), journal:
  first page (20), expected_tree_hash, expected_head_sha }`.
- `/api/journal/:projectId?q=<fts>&before=<id>&kind=<kind>` → paged (20)
  journal entries, filtered; `q` uses the existing `journal_fts` table;
  entries carry `has_patch` but not patch bodies.
- `/api/patch/:journalId` → `text/plain` raw patch (404 if none).
- `/api/version` → `{ seq }` where `seq` is a cheap change stamp:
  `max(journal.id) || 0` joined with counts of tasks/items/knowledge rows
  (string concat). The UI polls this every 2s and refetches the current view
  only when `seq` changes.

Unknown routes → 404 JSON `{error}`. Any handler error → 500 JSON `{error}`
(server keeps running). SQLITE_BUSY → one retry after 250ms, then 503.

### Security

- Listen on `127.0.0.1` only.
- Response header `Content-Security-Policy: default-src 'none'; script-src
  'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:`. The
  snapshot file uses inline script/style instead (`'unsafe-inline'` is
  acceptable there — it is a local file with no server).
- All DB-sourced strings reach the DOM via `textContent` (or equivalent
  escaping in the snapshot path). Journal entries and patches contain
  arbitrary code and must never be interpreted as HTML.
- `:id` route params validated as `/^\d+$/` before touching SQL (parameterized
  queries regardless).

## Visual system

Three hues, defined once in OKLCH, both themes derived from them. No other
hues anywhere — no green/red; pass/fail is carried by ✓/✕ glyphs, filled vs
outlined badges, and wording.

- **Mysterious blue** (anchor): `oklch(0.16 0.03 250)` dark background. A
  6-step ramp varies only lightness/chroma (surface, card, border, hover,
  muted text). Every "gray" is blue-tinted at hue 245–250 — never neutral.
- **Electric azure** (accent): `oklch(0.65 0.19 245)` — the single accent:
  active nav, links, progress, sparkline, focus rings, diff additions.
- **Warm white**: `oklch(0.97 0.005 250)` text on dark.

Light theme flips the skeleton: near-white blue-tinted background, deep-blue
text, the same accent darkened to hold WCAG AA on white. Theme = auto via
`prefers-color-scheme` + manual toggle persisted in `localStorage`. All colors
are CSS custom properties on `:root` / `[data-theme]`; no color literals
outside the token block.

Typography and layout: system font stack (SF Pro on macOS), `font-variant-
numeric: tabular-nums` for all stats, 8px spacing grid, generous whitespace,
bold display-size numbers (Spotify influence), restrained motion (150–200ms
ease transitions only; no gratuitous animation). Left rail navigation
(Spotify-style) listing projects with an accent pulse dot on projects with an
active task.

Diff rendering: additions tinted with the accent, deletions dimmed on a darker
surface with reduced opacity — still only the three hues.

## Views (hash-routed: `#/`, `#/project/:id`, `#/project/:id/journal`, `#/project/:id/knowledge`, `#/project/:id/gate`)

1. **Overview (`#/`)** — hero stat row (ticks this week, items done/total,
   open questions, active tasks), 30-day tick sparkline (inline SVG built from
   `ticks_30d_by_day`), open questions block at top (they are what waits on
   the human), recent journal across projects. Left rail lists projects.
2. **Project** — "now playing" card: active task title/status pill/progress
   bar (items done/total), item list with ✓ and `sensitive` markers, gate
   commands with last `gate_verdict`, tree state (expected_tree_hash short +
   expected_head_sha short, or "clean / committed"), latest ticks.
3. **Journal** — timeline, kind filter (tick/approval/stop/note), FTS search
   box (server-side via `q`), "load more" pagination via `before`, entry
   expand → decisions, questions, patch diff fetched lazily from
   `/api/patch/:journalId`.
4. **Knowledge** — sections grouped by kind (layout, boundary, convention,
   sensitive_zone, gotcha) with body, `paths_glob`, short `verified_sha`, and
   updated age.
5. **Gate & Prefs** — gate command list in run order; global and per-project
   prefs tables.

Empty states everywhere: no DB → "the factory has no memory yet — run
`/anakin init`"; project with no task → intake hint; empty journal/knowledge →
one quiet line, never a bare zero.

## Frontend implementation

`app.ts` is plain TS: a ~15-line `h(tag, props, ...children)` DOM helper
(always `textContent` for strings), a hash router, one `state` object per
view, `fetchJSON` with the version-poll loop, and pure render functions per
view. Re-render replaces the view container's children (the data volumes are
small; no diffing needed). Snapshot mode is detected by
`window.__SNAPSHOT__` and swaps the fetch layer for lookups into the inlined
object; polling and lazy patch fetch are disabled (patches are inlined too).

## Testing (`dashboard.test.ts`)

Same harness style as `anakin-db.test.ts`: mkdtemp `ANAKIN_HOME`, seed via the
real CLI, start the server on an ephemeral port (`--port 0` is not supported —
tests pick a random high port and retry once on collision), `fetch` against
it, kill the process.

- overview/project/journal/patch/version endpoints return the documented
  shapes on a seeded DB.
- FTS `q` filter returns the seeded old entry and not unrelated ones.
- `/api/version` changes after a `journal append` through the CLI.
- Missing DB → `empty: true` payloads, HTTP 200, server does not create the file.
- Escaping regression: seed a journal entry containing `<script>alert(1)`
  `</script>`; the snapshot output contains it only in escaped form.
- Snapshot: file is written, contains `window.__SNAPSHOT__`, and has no
  `http://` / `https://` references (self-contained).
- Read-only guarantee: the server's DB connection cannot write (assert a probe
  write through the same open mode throws).
- Route param validation: `/api/project/abc` → 400.

## Acceptance criteria

1. `bun test` green in `skills/anakin/scripts/` including the new
   `dashboard.test.ts`, existing 19 CLI tests untouched and green.
2. `bun dashboard.ts --open` on a DB with real data serves all five views with
   live polling; killing the process is the only teardown needed.
3. `bun dashboard.ts --snapshot out.html` produces one file that renders all
   views offline with identical visuals.
4. The dashboard never writes: DB opened readonly, no POST/PUT routes exist.
5. Both themes hold WCAG AA for body text and pass a manual look at all five
   views; no color literal outside the token block in `style.css`.
6. `/anakin dashboard` documented in `commands/anakin.md`; `grep` shows no new
   state files or commit behavior introduced anywhere in the skill markdown.
