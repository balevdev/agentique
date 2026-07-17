# ANAKIN Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only local dashboard (server + self-contained snapshot) over `~/.anakin/anakin.db`, shipped inside the anakin skill as plain HTML/CSS/TS with zero npm dependencies.

**Architecture:** A new `dashboard.ts` bun script opens the DB with `readonly: true` and serves a GET-only JSON API plus three static assets on `127.0.0.1`; `app.ts` (transpiled in memory by `Bun.build` at startup) is a framework-free hash-routed frontend; `--snapshot` inlines CSS/JS/data into one HTML file. `anakin-db.ts` is not modified.

**Tech Stack:** bun, `bun:sqlite`, `Bun.serve`, `Bun.build`, hand-rolled DOM helpers, OKLCH CSS custom properties.

Spec: `docs/superpowers/specs/2026-07-17-anakin-dashboard-design.md`.

## Global Constraints

- Zero npm dependencies; no bundler artifacts committed; bun only.
- The dashboard never writes: DB opened `{ readonly: true }`, GET-only routes.
- Listen on `127.0.0.1` only; CSP header `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:` on the HTML response (no CSP in the snapshot file).
- All DB-sourced strings reach the DOM as text nodes — never `innerHTML` with data.
- Exactly three hues, all defined in OKLCH in one token block in `style.css`; no color literals elsewhere; no green/red — pass/fail via ✓/✕ glyphs and filled/outlined badges.
- Never write the literal string `</script>` in `app.ts` or its comments (it would terminate the inline snapshot script).
- `ANAKIN_HOME` overrides the home dir exactly as in `anakin-db.ts`: `process.env.ANAKIN_HOME ?? join(process.env.HOME ?? "", ".anakin")`.
- Project ids are `hash16` 16-hex strings → validate `/^[a-f0-9]{16}$/`; journal ids numeric → `/^\d+$/`.
- All work happens in `skills/anakin/scripts/`; run tests with `export PATH="$HOME/.bun/bin:$PATH" && bun test` from that directory. The existing 19 CLI tests must stay green.

---

### Task 1: `dashboard.ts` — read-only API server

**Files:**
- Create: `skills/anakin/scripts/dashboard.ts`
- Create: `skills/anakin/scripts/dashboard/index.html` (stub, replaced in Task 2)
- Create: `skills/anakin/scripts/dashboard/style.css` (stub, replaced in Task 2)
- Create: `skills/anakin/scripts/dashboard/app.ts` (stub, replaced in Task 2)
- Test: `skills/anakin/scripts/dashboard.test.ts`

**Interfaces:**
- Consumes: `anakin-db.ts` CLI (test seeding only), `schema.sql` tables.
- Produces: HTTP GET endpoints `/api/overview`, `/api/project/:pid`, `/api/journal/:pid?q=&kind=&before=`, `/api/patch/:jid` (text/plain), `/api/version` → shapes as coded below; startup line `anakin dashboard http://127.0.0.1:<port> pid <pid>`; exported-in-spirit helpers `overview(db)`, `projectPayload(db, id)`, `journalPage(db, pid, opt)`, `version(db)` reused by Task 4's snapshot branch.

- [ ] **Step 1: Write the failing tests**

Create `skills/anakin/scripts/dashboard.test.ts`:

```ts
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const CLI = join(import.meta.dir, "anakin-db.ts");
const DASH = join(import.meta.dir, "dashboard.ts");
let home: string;

function run(args: string[], stdin?: string) {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    env: { ...process.env, ANAKIN_HOME: home },
    stdin: stdin !== undefined ? Buffer.from(stdin) : undefined,
    stdout: "pipe", stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(),
           json: () => JSON.parse(p.stdout.toString()) };
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "anakin-repo-"));
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, ...a]);
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return dir;
}

// Seed a project with a task, two items (one done), gate, knowledge, prefs and journal.
function seed() {
  const repo = makeRepo();
  const project = run(["init", "--repo", repo]).json();
  run(["prefs", "set", "--key", "style"], "boring code wins");
  run(["gate", "set", "--repo", repo], JSON.stringify([{ command: "bun test", reason: "unit" }]));
  const sha = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
  run(["knowledge", "set", "--repo", repo],
    JSON.stringify({ kind: "boundary", title: "no-infra", body: "domain never imports infra", paths_glob: "src/**", verified_sha: sha }));
  const t = run(["task", "new", "--repo", repo], JSON.stringify({ title: "Wire flux", description: "ticket" })).json();
  run(["task", "approve", "--repo", repo, "--id", String(t.id)]);
  const i1 = run(["item", "add", "--repo", repo, "--task", String(t.id)],
    JSON.stringify({ ordinal: 1, title: "flux capacitor wiring", files: "src/flux.ts", done_when: "green" })).json();
  run(["item", "add", "--repo", repo, "--task", String(t.id)],
    JSON.stringify({ ordinal: 2, title: "shield the coil", files: "src/coil.ts", done_when: "green", sensitive: "power" }));
  const patchFile = join(home, "p.diff");
  writeFileSync(patchFile, "diff --git a/src/flux.ts b/src/flux.ts\n+capacitor\n");
  const j = run(["journal", "append", "--repo", repo, "--patch-file", patchFile],
    JSON.stringify({ task_id: t.id, item_id: i1.id, entry_kind: "tick", gate_verdict: "green",
      decisions: "used polling because webhooks flaked", questions: "", head_sha: "a".repeat(40), tree_hash: "h1" })).json();
  run(["item", "check", "--repo", repo, "--id", String(i1.id), "--journal", String(j.id)]);
  run(["journal", "append", "--repo", repo],
    JSON.stringify({ task_id: t.id, entry_kind: "note", decisions: "chose sqlite for memory", questions: "should retention prune patches?" }));
  return { repo, project, task: t, item: i1, tick: j };
}

async function startDash(extra: string[] = []): Promise<{ port: number; base: string; stop: () => void }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 10000 + Math.floor(Math.random() * 50000);
    const p = Bun.spawn(["bun", DASH, "--port", String(port), ...extra], {
      env: { ...process.env, ANAKIN_HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    for (let i = 0; i < 50; i++) {
      if (p.exitCode !== null) break; // port clash → next attempt
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/version`);
        if (r.ok) return { port, base: `http://127.0.0.1:${port}`, stop: () => p.kill() };
      } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
    p.kill();
  }
  throw new Error("could not start dashboard server");
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anakin-home-")); });

describe("dashboard api", () => {
  test("overview: projects, totals, recent, questions", async () => {
    const { project } = seed();
    const d = await startDash();
    try {
      const o = await (await fetch(`${d.base}/api/overview`)).json();
      expect(o.projects).toHaveLength(1);
      expect(o.projects[0].id).toBe(project.id);
      expect(o.projects[0].active_task).toBe("Wire flux");
      expect(o.projects[0].items_done).toBe(1);
      expect(o.projects[0].items_total).toBe(2);
      expect(o.totals.ticks_7d).toBe(1);
      expect(o.totals.tasks_by_status.in_progress).toBe(1);
      expect(o.totals.open_questions).toBe(1);
      expect(o.recent.length).toBeGreaterThanOrEqual(2);
      expect(o.questions[0].questions).toContain("retention");
    } finally { d.stop(); }
  });

  test("project payload: task, items, gate, knowledge, prefs, expected tree", async () => {
    const { project } = seed();
    const d = await startDash();
    try {
      const p = await (await fetch(`${d.base}/api/project/${project.id}`)).json();
      expect(p.task.title).toBe("Wire flux");
      expect(p.task.status).toBe("in_progress");
      expect(p.items.map((i: any) => i.ordinal)).toEqual([1, 2]);
      expect(p.items[1].sensitive).toBe("power");
      expect(p.gate[0].command).toBe("bun test");
      expect(p.knowledge[0].title).toBe("no-infra");
      expect(p.prefs[0].body).toBe("boring code wins");
      expect(p.expected_tree_hash).toBe("h1");
      expect(p.expected_head_sha).toBe("a".repeat(40));
      expect(p.journal[0].entry_kind).toBe("note");
      expect(p.journal[0].has_patch).toBe(0);
      expect(p.journal[1].has_patch).toBe(1);
    } finally { d.stop(); }
  });

  test("journal: kind filter and FTS q filter", async () => {
    const { project } = seed();
    const d = await startDash();
    try {
      const ticks = await (await fetch(`${d.base}/api/journal/${project.id}?kind=tick`)).json();
      expect(ticks.entries).toHaveLength(1);
      expect(ticks.entries[0].entry_kind).toBe("tick");
      const hits = await (await fetch(`${d.base}/api/journal/${project.id}?q=webhooks`)).json();
      expect(hits.entries).toHaveLength(1);
      expect(hits.entries[0].decisions).toContain("polling");
      const none = await (await fetch(`${d.base}/api/journal/${project.id}?q=zzzunknown`)).json();
      expect(none.entries).toHaveLength(0);
    } finally { d.stop(); }
  });

  test("patch endpoint returns text; 404 when absent; bad ids rejected", async () => {
    const { project, tick } = seed();
    const d = await startDash();
    try {
      const r = await fetch(`${d.base}/api/patch/${tick.id}`);
      expect(r.headers.get("content-type")).toContain("text/plain");
      expect(await r.text()).toContain("capacitor");
      expect((await fetch(`${d.base}/api/patch/999999`)).status).toBe(404);
      expect((await fetch(`${d.base}/api/project/abc`)).status).toBe(400);
      expect((await fetch(`${d.base}/api/project/${"0".repeat(16)}`)).status).toBe(404);
      expect((await fetch(`${d.base}/api/journal/DROP%20TABLE`)).status).toBe(400);
    } finally { d.stop(); }
  });

  test("version changes when the journal grows", async () => {
    const { repo, task } = seed();
    const d = await startDash();
    try {
      const v1 = (await (await fetch(`${d.base}/api/version`)).json()).seq;
      run(["journal", "append", "--repo", repo],
        JSON.stringify({ task_id: task.id, entry_kind: "note", decisions: "another" }));
      const v2 = (await (await fetch(`${d.base}/api/version`)).json()).seq;
      expect(v2).not.toBe(v1);
    } finally { d.stop(); }
  });

  test("missing DB: empty payloads, 200s, and the file is never created", async () => {
    const d = await startDash();
    try {
      const o = await (await fetch(`${d.base}/api/overview`)).json();
      expect(o.empty).toBe(true);
      expect(o.projects).toEqual([]);
      expect((await fetch(`${d.base}/api/version`)).status).toBe(200);
      expect(existsSync(join(home, "anakin.db"))).toBe(false);
    } finally { d.stop(); }
  });

  test("non-GET is refused", async () => {
    seed();
    const d = await startDash();
    try {
      expect((await fetch(`${d.base}/api/overview`, { method: "POST" })).status).toBe(405);
    } finally { d.stop(); }
  });

  test("the dashboard's open mode cannot write", () => {
    seed();
    const db = new Database(join(home, "anakin.db"), { readonly: true });
    expect(() => db.run("INSERT INTO prefs (key, body) VALUES ('x','y')")).toThrow();
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd skills/anakin/scripts && bun test dashboard.test.ts`
Expected: FAIL — `could not start dashboard server` (dashboard.ts does not exist).

- [ ] **Step 3: Create the asset stubs**

`skills/anakin/scripts/dashboard/index.html` (final shell already — Task 2 only restyles):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>anakin — factory observatory</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
```

(The `<link …>` and `<script …>` lines must stay byte-identical — Task 4's snapshot inlining string-matches them.)

`skills/anakin/scripts/dashboard/style.css` stub:

```css
/* replaced in Task 2 */
body { font-family: system-ui; }
```

`skills/anakin/scripts/dashboard/app.ts` stub:

```ts
// replaced in Task 2
document.getElementById("app")!.append("anakin dashboard");
```

- [ ] **Step 4: Implement `skills/anakin/scripts/dashboard.ts`**

```ts
#!/usr/bin/env bun
// anakin dashboard — read-only observatory over the factory memory.
// GET-only JSON API + static UI on 127.0.0.1; never writes to the DB.
// Zero npm dependencies.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.ANAKIN_HOME ?? join(process.env.HOME ?? "", ".anakin");
const DB_PATH = join(HOME, "anakin.db");
const UI_DIR = fileURLToPath(new URL("./dashboard/", import.meta.url));
const PID_RE = /^[a-f0-9]{16}$/;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:";

function flags(argv: string[]): { _: string[]; [k: string]: any } {
  const r: { _: string[]; [k: string]: any } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { r[key] = next; i++; }
      else r[key] = true;
    } else r._.push(a);
  }
  return r;
}

// The DB is opened per request: cheap, and picks up a DB created after startup.
function openDb(): Database | null {
  if (!existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

// ---------- queries ----------

const OPEN_Q = `FROM journal j LEFT JOIN tasks t ON t.id = j.task_id
  WHERE j.questions != '' AND (t.status IS NULL OR t.status != 'committed')`;

function overview(db: Database | null) {
  if (!db) return { empty: true, projects: [], recent: [], questions: [],
    totals: { projects: 0, tasks_by_status: {}, ticks_7d: 0, ticks_30d_by_day: [], open_questions: 0 } };
  const projects = db.query(`
    SELECT p.id, p.name, p.abs_path, p.origin_url,
      (SELECT title  FROM tasks WHERE project_id = p.id AND status IN ('approved','in_progress','review') ORDER BY id DESC LIMIT 1) AS active_task,
      (SELECT status FROM tasks WHERE project_id = p.id AND status IN ('approved','in_progress','review') ORDER BY id DESC LIMIT 1) AS active_status,
      (SELECT COUNT(*) FROM items i JOIN tasks t ON i.task_id = t.id WHERE t.project_id = p.id AND i.status = 'done') AS items_done,
      (SELECT COUNT(*) FROM items i JOIN tasks t ON i.task_id = t.id WHERE t.project_id = p.id) AS items_total,
      (SELECT MAX(created_at) FROM journal WHERE project_id = p.id) AS last_activity
    FROM projects p
    ORDER BY last_activity IS NULL, last_activity DESC`).all();
  const tasksByStatus: Record<string, number> = {};
  for (const r of db.query("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status").all() as any[])
    tasksByStatus[r.status] = r.c;
  const totals = {
    projects: projects.length,
    tasks_by_status: tasksByStatus,
    ticks_7d: (db.query("SELECT COUNT(*) AS c FROM journal WHERE entry_kind = 'tick' AND created_at >= datetime('now','-7 days')").get() as any).c,
    ticks_30d_by_day: db.query("SELECT date(created_at) AS d, COUNT(*) AS c FROM journal WHERE entry_kind = 'tick' AND created_at >= datetime('now','-30 days') GROUP BY d ORDER BY d").all(),
    open_questions: (db.query(`SELECT COUNT(*) AS c ${OPEN_Q}`).get() as any).c,
  };
  const recent = db.query(`
    SELECT j.id, j.project_id, p.name AS project_name, j.entry_kind, j.gate_verdict,
           substr(j.decisions, 1, 200) AS decisions, i.title AS item_title, j.created_at
    FROM journal j JOIN projects p ON p.id = j.project_id LEFT JOIN items i ON i.id = j.item_id
    ORDER BY j.id DESC LIMIT 20`).all();
  const questions = db.query(`
    SELECT j.id, j.project_id, p.name AS project_name, t.title AS task_title, j.questions, j.created_at
    FROM journal j JOIN projects p ON p.id = j.project_id LEFT JOIN tasks t ON t.id = j.task_id
    WHERE j.questions != '' AND (t.status IS NULL OR t.status != 'committed')
    ORDER BY j.id DESC LIMIT 10`).all();
  return { projects, totals, recent, questions };
}

function journalPage(db: Database, projectId: string,
  opt: { q?: string; before?: number; kind?: string; limit?: number }) {
  const limit = Math.min(opt.limit ?? 20, 10000);
  const cond: string[] = ["j.project_id = ?"];
  const args: any[] = [projectId];
  if (opt.kind) { cond.push("j.entry_kind = ?"); args.push(opt.kind); }
  if (opt.before) { cond.push("j.id < ?"); args.push(opt.before); }
  if (opt.q) {
    const match = opt.q.trim().split(/\s+/).map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
    let rowids: number[] = [];
    try {
      rowids = (db.query("SELECT rowid FROM journal_fts WHERE journal_fts MATCH ? LIMIT 500")
        .all(match) as any[]).map((r) => r.rowid);
    } catch { /* unparseable FTS query → no hits */ }
    if (rowids.length === 0) return { entries: [], next_before: null };
    cond.push(`j.id IN (${rowids.map(() => "?").join(",")})`);
    args.push(...rowids);
  }
  const entries = db.query(`
    SELECT j.id, j.task_id, j.item_id, j.entry_kind, j.gate_verdict, j.decisions, j.questions,
           j.head_sha, j.tree_hash, j.created_at, (j.patch IS NOT NULL) AS has_patch,
           i.title AS item_title
    FROM journal j LEFT JOIN items i ON i.id = j.item_id
    WHERE ${cond.join(" AND ")} ORDER BY j.id DESC LIMIT ${limit}`).all(...args) as any[];
  return { entries, next_before: entries.length === limit ? entries[entries.length - 1].id : null };
}

function projectPayload(db: Database | null, id: string) {
  if (!db) return { empty: true };
  const project = db.query("SELECT * FROM projects WHERE id = ?").get(id);
  if (!project) return null;
  const task = db.query(`SELECT * FROM tasks WHERE project_id = ? AND status IN ('approved','in_progress','review')
                         ORDER BY id DESC LIMIT 1`).get(id)
    ?? db.query("SELECT * FROM tasks WHERE project_id = ? ORDER BY id DESC LIMIT 1").get(id) ?? null;
  const items = task
    ? db.query("SELECT * FROM items WHERE task_id = ? ORDER BY ordinal").all((task as any).id) : [];
  const lastTick: any = task
    ? db.query("SELECT head_sha, tree_hash FROM journal WHERE task_id = ? AND entry_kind = 'tick' ORDER BY id DESC LIMIT 1").get((task as any).id)
    : null;
  return {
    project, task, items,
    gate: db.query("SELECT ordinal, command, reason FROM gate_commands WHERE project_id = ? ORDER BY ordinal").all(id),
    knowledge: db.query("SELECT * FROM knowledge_sections WHERE project_id = ? ORDER BY kind, title").all(id),
    prefs: db.query("SELECT key, body FROM prefs ORDER BY key").all(),
    tasks_all: db.query("SELECT id, title, status, created_at FROM tasks WHERE project_id = ? ORDER BY id DESC").all(id),
    expected_head_sha: lastTick?.head_sha ?? null,
    expected_tree_hash: lastTick?.tree_hash ?? null,
    journal: journalPage(db, id, {}).entries,
  };
}

function version(db: Database | null) {
  if (!db) return { seq: "empty" };
  const r = db.query(`SELECT (SELECT COALESCE(MAX(id), 0) FROM journal) || ':' ||
      (SELECT COUNT(*) FROM tasks) || ':' ||
      (SELECT COUNT(*) || '-' || COALESCE(SUM(CASE status WHEN 'done' THEN 1 ELSE 0 END), 0) FROM items) || ':' ||
      (SELECT COUNT(*) FROM knowledge_sections) || ':' ||
      (SELECT COALESCE(MAX(updated_at), '') FROM tasks) AS seq`).get() as any;
  return { seq: r.seq };
}

// ---------- http ----------

const INDEX_HTML = readFileSync(join(UI_DIR, "index.html"), "utf8");
const CSS = readFileSync(join(UI_DIR, "style.css"), "utf8");
const build = await Bun.build({ entrypoints: [join(UI_DIR, "app.ts")], target: "browser" });
if (!build.success) {
  console.error("app.ts failed to build:\n" + build.logs.join("\n"));
  process.exit(1);
}
const APP_JS = await build.outputs[0].text();

function json(x: unknown, status = 200): Response {
  return new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (req.method !== "GET") return json({ error: "read-only" }, 405);
  if (p === "/") return new Response(INDEX_HTML,
    { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP } });
  if (p === "/style.css") return new Response(CSS, { headers: { "content-type": "text/css; charset=utf-8" } });
  if (p === "/app.js") return new Response(APP_JS, { headers: { "content-type": "text/javascript; charset=utf-8" } });
  if (!p.startsWith("/api/")) return json({ error: "not found" }, 404);
  const db = openDb();
  try {
    if (p === "/api/overview") return json(overview(db));
    if (p === "/api/version") return json(version(db));
    let m = p.match(/^\/api\/project\/([^/]+)$/);
    if (m) {
      if (!PID_RE.test(m[1])) return json({ error: "bad project id" }, 400);
      const payload = projectPayload(db, m[1]);
      return payload === null ? json({ error: "no such project" }, 404) : json(payload);
    }
    m = p.match(/^\/api\/journal\/([^/]+)$/);
    if (m) {
      if (!PID_RE.test(m[1])) return json({ error: "bad project id" }, 400);
      if (!db) return json({ empty: true, entries: [], next_before: null });
      const before = url.searchParams.get("before");
      return json(journalPage(db, m[1], {
        q: url.searchParams.get("q") ?? undefined,
        kind: url.searchParams.get("kind") ?? undefined,
        before: before && /^\d+$/.test(before) ? Number(before) : undefined,
      }));
    }
    m = p.match(/^\/api\/patch\/(\d+)$/);
    if (m) {
      const row = db?.query("SELECT patch FROM journal WHERE id = ?").get(Number(m[1])) as any;
      if (!row || row.patch == null) return json({ error: "no patch" }, 404);
      return new Response(row.patch, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    if (String(e).includes("SQLITE_BUSY")) return json({ error: "db busy" }, 503);
    return json({ error: String(e) }, 500);
  } finally {
    db?.close();
  }
}

// ---------- main ----------

const argv = flags(process.argv.slice(2));
const port = argv.port !== undefined ? Number(argv.port) : 4600;
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("--port requires a valid port number");
  process.exit(1);
}
let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      let res = await handle(req);
      if (res.status === 503) { await Bun.sleep(250); res = await handle(req); }
      return res;
    },
  });
} catch (e) {
  console.error(`cannot listen on 127.0.0.1:${port} — ${e}`);
  process.exit(1);
}
const url = `http://127.0.0.1:${server.port}`;
console.log(`anakin dashboard ${url} pid ${process.pid}`);
if (argv.open) Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url]);
```

(`writeFileSync` and `resolve` are imported now; the snapshot branch that uses them lands in Task 4.)

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test dashboard.test.ts`
Expected: 8 pass, 0 fail.

- [ ] **Step 6: Run the whole suite**

Run: `bun test`
Expected: 27 pass (19 existing + 8 new), 0 fail.

- [ ] **Step 7: Commit**

```bash
cd /Users/boyan.balev/projects/agentique
git add skills/anakin/scripts/dashboard.ts skills/anakin/scripts/dashboard/ skills/anakin/scripts/dashboard.test.ts
git commit -m "feat(anakin): read-only dashboard API server over the factory DB"
```

---

### Task 2: Frontend shell — visual system, rail, overview

**Files:**
- Replace: `skills/anakin/scripts/dashboard/style.css`
- Replace: `skills/anakin/scripts/dashboard/app.ts`
- Test: extend `skills/anakin/scripts/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 1 endpoints; `index.html` shell (`#app` container).
- Produces: `app.ts` functions Task 3 extends: `h()`, `link()`, `api()`, `apiText()`, `timeAgo()`, `short()`, `kindBadge()`, `route()`, `render()`, `renderRail()`, `renderOverview()`, `emptyState()`, `sparkline()`; CSS classes used by Task 3 (`view card card-title quiet mono badge pill btn stat-grid stat toolbar search j-* k-* item-* gate-row tabs tab diff dline add del hunk progress progress-fill hero`).

- [ ] **Step 1: Write the failing tests** (append to `dashboard.test.ts`)

```ts
describe("dashboard ui assets", () => {
  test("serves html with CSP, css tokens, and the built app", async () => {
    seed();
    const d = await startDash();
    try {
      const home_ = await fetch(`${d.base}/`);
      expect(home_.headers.get("content-type")).toContain("text/html");
      expect(home_.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await home_.text()).toContain('<div id="app">');
      const css = await (await fetch(`${d.base}/style.css`)).text();
      expect(css).toContain("oklch(");
      expect(css).toContain('[data-theme="light"]');
      const js = await (await fetch(`${d.base}/app.js`)).text();
      expect(js).toContain("renderOverview");
    } finally { d.stop(); }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test dashboard.test.ts`
Expected: the new test FAILS (`oklch(` not in stub css); the Task 1 tests still pass.

- [ ] **Step 3: Write `skills/anakin/scripts/dashboard/style.css`**

```css
/* anakin dashboard — three hues, all OKLCH, tokens only here.
   dark = identity (mysterious blue); light derived from the same skeleton. */
:root {
  --bg:      oklch(0.16 0.030 250);
  --surface: oklch(0.185 0.032 250);
  --card:    oklch(0.215 0.034 250);
  --hover:   oklch(0.25 0.036 250);
  --border:  oklch(0.29 0.036 250);
  --text:    oklch(0.97 0.005 250);
  --text-2:  oklch(0.76 0.028 250);
  --text-3:  oklch(0.56 0.038 250);
  --accent:  oklch(0.65 0.19 245);
  --accent-strong: oklch(0.72 0.17 245);
  --accent-soft: oklch(0.65 0.19 245 / 0.14);
  --shadow: 0 1px 2px oklch(0.08 0.02 250 / 0.5), 0 8px 24px oklch(0.08 0.02 250 / 0.35);
}
:root[data-theme="light"] {
  --bg:      oklch(0.985 0.004 250);
  --surface: oklch(0.965 0.007 250);
  --card:    oklch(0.995 0.002 250);
  --hover:   oklch(0.945 0.010 250);
  --border:  oklch(0.90 0.014 250);
  --text:    oklch(0.25 0.045 250);
  --text-2:  oklch(0.45 0.038 250);
  --text-3:  oklch(0.60 0.030 250);
  --accent:  oklch(0.52 0.19 245);
  --accent-strong: oklch(0.45 0.19 245);
  --accent-soft: oklch(0.52 0.19 245 / 0.10);
  --shadow: 0 1px 2px oklch(0.3 0.03 250 / 0.08), 0 8px 24px oklch(0.3 0.03 250 / 0.06);
}

* { box-sizing: border-box; margin: 0; }
html { color-scheme: dark light; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  background: var(--bg); color: var(--text);
  font-size: 14px; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
#app { display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; }
a { color: inherit; text-decoration: none; }
code, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.92em; }
h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
h2 { font-size: 17px; font-weight: 650; letter-spacing: -0.01em; }
.quiet { color: var(--text-3); font-size: 12.5px; }
pre { white-space: pre-wrap; word-break: break-word; font: inherit; color: var(--text-2); }

/* rail */
.rail {
  background: var(--surface); border-right: 1px solid var(--border);
  padding: 20px 12px; display: flex; flex-direction: column; gap: 2px;
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
}
.brand {
  font-size: 15px; font-weight: 750; letter-spacing: 0.14em; text-transform: lowercase;
  color: var(--accent); padding: 0 10px 14px;
}
.rail-head {
  font-size: 10.5px; font-weight: 650; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--text-3); padding: 16px 10px 6px;
}
.rail-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; border-radius: 8px; color: var(--text-2);
  transition: background 150ms ease, color 150ms ease;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rail-item:hover { background: var(--hover); color: var(--text); }
.rail-item.active { background: var(--accent-soft); color: var(--accent-strong); font-weight: 600; }
.pulse {
  width: 7px; height: 7px; border-radius: 50%; background: var(--accent);
  animation: pulse 2.4s ease-in-out infinite; flex: none; margin-left: auto;
}
@keyframes pulse { 50% { opacity: 0.35; } }
.rail-foot { margin-top: auto; padding: 8px 10px; }
.snap-badge {
  margin: 0 10px 8px; padding: 2px 8px; border-radius: 999px; align-self: start;
  border: 1px solid var(--accent); color: var(--accent); font-size: 11px;
}
.theme-toggle {
  background: none; border: 1px solid var(--border); color: var(--text-2);
  border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 14px;
  transition: border-color 150ms ease, color 150ms ease;
}
.theme-toggle:hover { border-color: var(--accent); color: var(--accent); }

/* main + cards */
.main { padding: 28px 32px 64px; max-width: 880px; width: 100%; margin: 0 auto; }
.view { display: flex; flex-direction: column; gap: 16px; }
.card {
  background: var(--card); border: 1px solid var(--border); border-radius: 14px;
  padding: 18px 20px; box-shadow: var(--shadow);
}
.card-title {
  font-size: 11px; font-weight: 650; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--text-3); margin-bottom: 10px;
}
.banner { border: 1px solid var(--border); border-left: 3px solid var(--accent);
  border-radius: 10px; padding: 10px 14px; color: var(--text-2); }

/* stats */
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat-value {
  font-size: 34px; font-weight: 750; letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums; color: var(--text);
}
.stat-label { color: var(--text-3); font-size: 12px; letter-spacing: 0.04em; }

/* sparkline */
.spark { width: 100%; height: 56px; display: block; }
.spark polyline { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }

/* badges & pills */
.badge {
  display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px;
  background: var(--accent-soft); color: var(--accent-strong);
  font-size: 11px; font-weight: 600; white-space: nowrap;
}
.badge.fail, .badge.stop { background: none; border: 1px solid var(--accent); }
.badge.outline { background: none; border: 1px solid var(--border); color: var(--text-3); }
.pill {
  display: inline-flex; padding: 2px 10px; border-radius: 999px;
  font-size: 11.5px; font-weight: 650; letter-spacing: 0.03em;
  background: var(--accent-soft); color: var(--accent-strong);
}
.pill.draft, .pill.review, .pill.committed { background: var(--hover); color: var(--text-2); }

/* rows */
.q-row, .j-row { display: flex; flex-direction: column; gap: 2px; padding: 9px 10px; margin: 0 -10px;
  border-radius: 10px; transition: background 150ms ease; }
.j-row { flex-direction: row; gap: 10px; align-items: baseline; }
.j-main { min-width: 0; flex: 1; }
.q-row:hover, .j-row:hover { background: var(--hover); }

/* empty */
.empty { align-items: center; text-align: center; padding-top: 12vh; gap: 8px; }
.empty-mark { font-size: 40px; color: var(--accent); }
```

- [ ] **Step 4: Write `skills/anakin/scripts/dashboard/app.ts`**

```ts
// anakin dashboard frontend — zero deps, no framework.
// Every DB-sourced string enters the DOM as a text node via h()/append(),
// never as HTML.

type Json = any;
const SNAP: Json | null = (window as any).__SNAPSHOT__ ?? null;

// ---------- data ----------

function snapLookup(path: string): Json {
  const [p, qs] = path.split("?");
  const params = new URLSearchParams(qs ?? "");
  if (p === "/api/overview") return SNAP.overview;
  if (p === "/api/version") return { seq: "snapshot" };
  let m = p.match(/^\/api\/project\/(\w+)$/);
  if (m) return SNAP.projects[m[1]] ?? null;
  m = p.match(/^\/api\/journal\/(\w+)$/);
  if (m) {
    let e: Json[] = SNAP.journal[m[1]] ?? [];
    const kind = params.get("kind"), q = params.get("q")?.toLowerCase();
    if (kind) e = e.filter((x) => x.entry_kind === kind);
    if (q) e = e.filter((x) => `${x.decisions} ${x.questions} ${x.item_title ?? ""}`.toLowerCase().includes(q));
    return { entries: e, next_before: null };
  }
  m = p.match(/^\/api\/patch\/(\d+)$/);
  if (m) return SNAP.patches[m[1]] ?? "";
  return null;
}

async function api(path: string): Promise<Json> {
  if (SNAP) return snapLookup(path);
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} on ${path}`);
  return r.json();
}

async function apiText(path: string): Promise<string> {
  if (SNAP) return snapLookup(path) ?? "";
  const r = await fetch(path);
  return r.ok ? r.text() : "";
}

// ---------- dom ----------

function h(tag: string, cls = "", ...kids: (Node | string | number | null | undefined)[]): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const k of kids) if (k !== null && k !== undefined) el.append(k as any);
  return el;
}

function link(hash: string, cls: string, ...kids: (Node | string)[]): HTMLElement {
  const a = h("a", cls, ...kids) as HTMLAnchorElement;
  a.href = hash;
  return a;
}

function timeAgo(ts: string | null): string {
  if (!ts) return "—";
  const t = new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z").getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 8) : "—");

// Pass/fail carries via glyphs and filled-vs-outlined badges — never extra hues.
function kindBadge(kind: string, verdict?: string | null): HTMLElement {
  const ok = verdict == null || /green|pass/i.test(verdict);
  const label = kind === "tick" ? (ok ? "✓ tick" : "✕ tick") : kind;
  return h("span", `badge ${kind}${ok ? "" : " fail"}`, label);
}

// ---------- theme ----------

function initTheme() {
  const saved = localStorage.getItem("anakin-theme");
  document.documentElement.dataset.theme =
    saved ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}

function themeToggle(): HTMLElement {
  const b = h("button", "theme-toggle", "◐");
  b.title = "toggle theme";
  b.onclick = () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("anakin-theme", next);
  };
  return b;
}

// ---------- router ----------

const root = document.getElementById("app")!;
let seq = "";

function route(): { view: string; pid: string | null } {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "p" && parts[1]) return { view: parts[2] ?? "task", pid: parts[1] };
  return { view: "overview", pid: null };
}

async function render() {
  const r = route();
  const o = await api("/api/overview");
  const main = h("main", "main");
  try {
    if (o.empty) main.append(emptyState());
    else if (!r.pid) main.append(renderOverview(o));
    else {
      const p = await api(`/api/project/${r.pid}`);
      if (!p) main.append(h("p", "quiet", "unknown project"));
      else main.append(await renderProjectView(r, p));
    }
  } catch (e) {
    main.append(h("div", "banner", `something went wrong: ${e}`));
  }
  root.replaceChildren(renderRail(o, r), main);
}

// Task 3 replaces this stub with the real project views.
async function renderProjectView(r: { view: string; pid: string | null }, p: Json): Promise<HTMLElement> {
  return h("div", "card", h("p", "quiet", p.project.name));
}

async function poll() {
  // Don't yank the DOM out from under someone typing in a filter.
  if (!(document.activeElement instanceof HTMLInputElement)) {
    try {
      const v = await api("/api/version");
      if (v.seq !== seq) { seq = v.seq; await render(); }
    } catch { /* server briefly away — keep polling */ }
  }
  setTimeout(poll, 2000);
}

// ---------- views ----------

function renderRail(o: Json, r: { view: string; pid: string | null }): HTMLElement {
  const rail = h("nav", "rail");
  rail.append(link("#/", "brand", "anakin"));
  if (SNAP) rail.append(h("span", "snap-badge", "snapshot"));
  rail.append(link("#/", `rail-item${!r.pid ? " active" : ""}`, "Overview"));
  rail.append(h("div", "rail-head", "Projects"));
  for (const p of o.projects ?? []) {
    const item = link(`#/p/${p.id}`, `rail-item${r.pid === p.id ? " active" : ""}`, p.name);
    if (p.active_task) item.append(h("span", "pulse"));
    rail.append(item);
  }
  const foot = h("div", "rail-foot");
  foot.append(themeToggle());
  rail.append(foot);
  return rail;
}

function emptyState(): HTMLElement {
  return h("div", "view empty",
    h("div", "empty-mark", "◍"),
    h("h1", "", "the factory has no memory yet"),
    h("p", "quiet", "run /anakin init in a repo to begin"));
}

function stat(label: string, value: string | number): HTMLElement {
  return h("div", "stat card", h("div", "stat-value", String(value)), h("div", "stat-label", label));
}

function sparkline(days: { d: string; c: number }[]): SVGElement {
  const W = 560, H = 56;
  const map = new Map(days.map((x) => [x.d, x.c]));
  const pts: number[] = [];
  for (let i = 29; i >= 0; i--)
    pts.push(map.get(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)) ?? 0);
  const max = Math.max(...pts, 1);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("spark");
  const poly = document.createElementNS(NS, "polyline");
  poly.setAttribute("points",
    pts.map((v, i) => `${(i / 29) * W},${H - 6 - (v / max) * (H - 12)}`).join(" "));
  svg.append(poly);
  return svg;
}

function renderOverview(o: Json): HTMLElement {
  const v = h("div", "view");
  v.append(h("h1", "", "Overview"));
  const t = o.totals;
  const active = (t.tasks_by_status.approved ?? 0) + (t.tasks_by_status.in_progress ?? 0) + (t.tasks_by_status.review ?? 0);
  const done = o.projects.reduce((a: number, p: Json) => a + p.items_done, 0);
  const total = o.projects.reduce((a: number, p: Json) => a + p.items_total, 0);
  v.append(h("div", "stat-grid",
    stat("ticks · 7 days", t.ticks_7d),
    stat("items done", `${done}/${total}`),
    stat("open questions", t.open_questions),
    stat("active tasks", active)));

  const sc = h("div", "card");
  sc.append(h("div", "card-title", "ticks · last 30 days"), sparkline(t.ticks_30d_by_day));
  v.append(sc);

  if (o.questions.length) {
    const qc = h("div", "card");
    qc.append(h("div", "card-title", "waiting on you"));
    for (const q of o.questions)
      qc.append(link(`#/p/${q.project_id}/journal`, "q-row",
        h("div", "", q.questions),
        h("div", "quiet", `${q.project_name}${q.task_title ? " · " + q.task_title : ""} · ${timeAgo(q.created_at)}`)));
    v.append(qc);
  }

  const rc = h("div", "card");
  rc.append(h("div", "card-title", "recent activity"));
  for (const e of o.recent)
    rc.append(link(`#/p/${e.project_id}/journal`, "j-row",
      kindBadge(e.entry_kind, e.gate_verdict),
      h("div", "j-main",
        h("div", "", e.item_title ?? e.decisions ?? e.entry_kind),
        h("div", "quiet", `${e.project_name} · ${timeAgo(e.created_at)}`))));
  if (!o.recent.length) rc.append(h("p", "quiet", "no activity yet"));
  v.append(rc);
  return v;
}

// ---------- boot ----------

initTheme();
addEventListener("hashchange", render);
render();
if (!SNAP) poll();
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test dashboard.test.ts`
Expected: 9 pass, 0 fail (server startup also proves `app.ts` builds cleanly).

- [ ] **Step 6: Commit**

```bash
cd /Users/boyan.balev/projects/agentique
git add skills/anakin/scripts/dashboard/
git commit -m "feat(anakin): dashboard shell — OKLCH visual system, rail, overview"
```

---

### Task 3: Project views — task, journal + diff, knowledge, gate & prefs

**Files:**
- Modify: `skills/anakin/scripts/dashboard/app.ts` (replace the `renderProjectView` stub; add view functions)
- Test: extend `skills/anakin/scripts/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers (`h`, `link`, `api`, `apiText`, `timeAgo`, `short`, `kindBadge`) and Task 1 endpoints.
- Produces: `renderProject(p)`, `renderJournal(pid, p)`, `renderKnowledge(p)`, `renderGate(p)`, `journalRow(e)`, `renderDiff(patch)`, `projectHeader(p, active)` — all reachable from `renderProjectView`.

- [ ] **Step 1: Write the failing test** (append to `dashboard.test.ts`)

```ts
describe("dashboard views", () => {
  test("built app contains all view renderers and the diff viewer", async () => {
    seed();
    const d = await startDash();
    try {
      const js = await (await fetch(`${d.base}/app.js`)).text();
      for (const fn of ["renderProject", "renderJournal", "renderKnowledge", "renderGate", "renderDiff"])
        expect(js).toContain(fn);
    } finally { d.stop(); }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test dashboard.test.ts`
Expected: new test FAILS (`renderProject` absent).

- [ ] **Step 3: Implement the views in `app.ts`**

Replace the `renderProjectView` stub with:

```ts
async function renderProjectView(r: { view: string; pid: string | null }, p: Json): Promise<HTMLElement> {
  if (r.view === "journal") return renderJournal(r.pid!, p);
  if (r.view === "knowledge") return renderKnowledge(p);
  if (r.view === "gate") return renderGate(p);
  return renderProject(p);
}
```

Append the view functions (before the `// ---------- boot ----------` section):

```ts
// ---------- project views ----------

function projectHeader(p: Json, active: string): HTMLElement {
  const id = p.project.id;
  const tabs = h("div", "tabs");
  const spec: [string, string, string][] = [
    ["task", `#/p/${id}`, "Task"],
    ["journal", `#/p/${id}/journal`, "Journal"],
    ["knowledge", `#/p/${id}/knowledge`, "Knowledge"],
    ["gate", `#/p/${id}/gate`, "Gate & Prefs"],
  ];
  for (const [key, href, label] of spec)
    tabs.append(link(href, `tab${active === key ? " active" : ""}`, label));
  return h("header", "project-head",
    h("h1", "", p.project.name),
    h("div", "quiet mono", p.project.abs_path),
    tabs);
}

function statusPill(status: string): HTMLElement {
  return h("span", `pill ${status}`, status.replace("_", " "));
}

function renderProject(p: Json): HTMLElement {
  const v = h("div", "view");
  v.append(projectHeader(p, "task"));
  if (!p.task) {
    v.append(h("div", "card", h("p", "quiet", "no task yet — /anakin task <ticket> starts intake")));
    return v;
  }
  const t = p.task;
  const done = p.items.filter((i: Json) => i.status === "done").length;

  const hero = h("div", "card hero");
  hero.append(h("div", "hero-top", statusPill(t.status), h("span", "quiet", `updated ${timeAgo(t.updated_at)}`)));
  hero.append(h("h2", "", t.title));
  if (t.description) hero.append(h("p", "quiet", t.description));
  const bar = h("div", "progress");
  const fill = h("div", "progress-fill");
  fill.style.width = p.items.length ? `${(done / p.items.length) * 100}%` : "0";
  bar.append(fill);
  hero.append(h("div", "hero-progress", bar, h("span", "mono quiet", `${done}/${p.items.length}`)));
  hero.append(h("div", "quiet mono", p.expected_tree_hash
    ? `tree ${short(p.expected_tree_hash)} · head ${short(p.expected_head_sha)}`
    : "tree clean"));
  v.append(hero);

  const il = h("div", "card");
  il.append(h("div", "card-title", "items"));
  for (const i of p.items)
    il.append(h("div", `item-row${i.status === "done" ? " done" : ""}`,
      h("span", "item-mark", i.status === "done" ? "✓" : "○"),
      h("div", "j-main", h("div", "", i.title), i.files ? h("div", "quiet mono", i.files) : null),
      i.sensitive ? h("span", "badge outline", "sensitive") : null));
  if (!p.items.length) il.append(h("p", "quiet", "no items yet"));
  v.append(il);

  const gc = h("div", "card");
  gc.append(h("div", "card-title", "gate"));
  for (const g of p.gate)
    gc.append(h("div", "gate-row", h("code", "", g.command), g.reason ? h("span", "quiet", g.reason) : null));
  if (!p.gate.length) gc.append(h("p", "quiet", "no gate commands recorded"));
  const lastTick = p.journal.find((e: Json) => e.entry_kind === "tick");
  if (lastTick?.gate_verdict)
    gc.append(h("div", "gate-verdict quiet", "last verdict ", kindBadge("tick", lastTick.gate_verdict)));
  v.append(gc);

  const jc = h("div", "card");
  jc.append(h("div", "card-title", "latest activity"));
  for (const e of p.journal.slice(0, 5)) jc.append(journalRow(e));
  if (!p.journal.length) jc.append(h("p", "quiet", "quiet so far"));
  v.append(jc);
  return v;
}

function renderDiff(patch: string): HTMLElement {
  const box = h("div", "diff");
  for (const line of patch.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del"
      : line.startsWith("@@") ? "hunk" : "";
    box.append(h("div", `dline ${cls}`, line || " "));
  }
  return box;
}

function journalRow(e: Json): HTMLElement {
  const row = h("div", "j-entry");
  const head = h("div", "j-head",
    kindBadge(e.entry_kind, e.gate_verdict),
    h("div", "j-main",
      h("div", "", e.item_title ?? (e.decisions ? e.decisions.split("\n")[0] : e.entry_kind)),
      h("div", "quiet", timeAgo(e.created_at))));
  const body = h("div", "j-body");
  if (e.decisions) body.append(h("pre", "", e.decisions));
  if (e.questions) body.append(h("div", "q-block", h("div", "card-title", "questions"), h("pre", "", e.questions)));
  if (e.tree_hash) body.append(h("div", "quiet mono", `tree ${short(e.tree_hash)} · head ${short(e.head_sha)}`));
  if (e.has_patch) {
    const btn = h("button", "btn", "view patch");
    (btn as HTMLButtonElement).onclick = async () => {
      btn.replaceWith(renderDiff(await apiText(`/api/patch/${e.id}`)));
    };
    body.append(btn);
  }
  body.hidden = true;
  head.onclick = () => { body.hidden = !body.hidden; };
  row.append(head, body);
  return row;
}

async function renderJournal(pid: string, p: Json): Promise<HTMLElement> {
  const v = h("div", "view");
  v.append(projectHeader(p, "journal"));
  const search = h("input", "search") as HTMLInputElement;
  search.placeholder = "search memory…";
  const select = h("select", "kind-select") as HTMLSelectElement;
  for (const k of ["all", "tick", "approval", "stop", "note"]) {
    const opt = document.createElement("option");
    opt.value = k === "all" ? "" : k;
    opt.textContent = k;
    select.append(opt);
  }
  v.append(h("div", "toolbar", search, select));
  const list = h("div", "j-list");
  const more = h("button", "btn more", "older entries");
  v.append(list, more);

  let before: number | null = null;
  async function load(reset: boolean) {
    if (reset) { list.replaceChildren(); before = null; }
    const qs = new URLSearchParams();
    if (search.value.trim()) qs.set("q", search.value.trim());
    if (select.value) qs.set("kind", select.value);
    if (before) qs.set("before", String(before));
    const page = await api(`/api/journal/${pid}?${qs}`);
    for (const e of page.entries) list.append(journalRow(e));
    if (!list.children.length) list.append(h("p", "quiet", "nothing here"));
    before = page.next_before;
    more.hidden = !before;
  }
  let deb: ReturnType<typeof setTimeout>;
  search.oninput = () => { clearTimeout(deb); deb = setTimeout(() => load(true), 250); };
  select.onchange = () => load(true);
  (more as HTMLButtonElement).onclick = () => load(false);
  await load(true);
  return v;
}

const KINDS = ["layout", "boundary", "convention", "sensitive_zone", "gotcha"];

function renderKnowledge(p: Json): HTMLElement {
  const v = h("div", "view");
  v.append(projectHeader(p, "knowledge"));
  if (!p.knowledge.length) v.append(h("div", "card", h("p", "quiet", "no knowledge recorded yet")));
  for (const kind of KINDS) {
    const secs = p.knowledge.filter((k: Json) => k.kind === kind);
    if (!secs.length) continue;
    const c = h("div", "card");
    c.append(h("div", "card-title", kind.replace("_", " ")));
    for (const s of secs)
      c.append(h("div", "k-row",
        h("div", "k-head", h("strong", "", s.title),
          h("span", "quiet mono", `${s.paths_glob || "*"} · ${short(s.verified_sha)} · ${timeAgo(s.updated_at)}`)),
        h("pre", "k-body", s.body)));
    v.append(c);
  }
  return v;
}

function renderGate(p: Json): HTMLElement {
  const v = h("div", "view");
  v.append(projectHeader(p, "gate"));
  const gc = h("div", "card");
  gc.append(h("div", "card-title", "gate — runs in order, every tick"));
  p.gate.forEach((g: Json, i: number) =>
    gc.append(h("div", "gate-row",
      h("span", "quiet mono", String(i + 1)),
      h("code", "", g.command),
      g.reason ? h("span", "quiet", g.reason) : null)));
  if (!p.gate.length) gc.append(h("p", "quiet", "no gate commands recorded"));
  v.append(gc);
  const pc = h("div", "card");
  pc.append(h("div", "card-title", "prefs — global"));
  for (const pref of p.prefs)
    pc.append(h("div", "k-row", h("div", "k-head", h("strong", "", pref.key)), h("pre", "k-body", pref.body)));
  if (!p.prefs.length) pc.append(h("p", "quiet", "no prefs set"));
  v.append(pc);
  return v;
}
```

- [ ] **Step 4: Append the view styles to `style.css`**

```css
/* project views */
.project-head { display: flex; flex-direction: column; gap: 4px; margin-bottom: 4px; }
.tabs { display: flex; gap: 4px; margin-top: 12px; border-bottom: 1px solid var(--border); }
.tab {
  padding: 7px 14px; border-radius: 9px 9px 0 0; color: var(--text-3); font-weight: 550;
  transition: color 150ms ease, background 150ms ease;
}
.tab:hover { color: var(--text); background: var(--hover); }
.tab.active { color: var(--accent-strong); box-shadow: inset 0 -2px var(--accent); }

.hero { display: flex; flex-direction: column; gap: 10px; }
.hero-top { display: flex; justify-content: space-between; align-items: center; }
.hero-progress { display: flex; align-items: center; gap: 12px; }
.progress { flex: 1; height: 6px; border-radius: 999px; background: var(--hover); overflow: hidden; }
.progress-fill { height: 100%; border-radius: 999px; background: var(--accent); transition: width 200ms ease; }

.item-row { display: flex; gap: 10px; align-items: baseline; padding: 8px 0; border-top: 1px solid var(--border); }
.item-row:first-of-type { border-top: 0; }
.item-row.done { color: var(--text-3); }
.item-mark { color: var(--accent); font-weight: 700; width: 16px; flex: none; }
.item-row:not(.done) .item-mark { color: var(--text-3); }

.gate-row { display: flex; gap: 10px; align-items: baseline; padding: 6px 0; }
.gate-verdict { display: flex; gap: 6px; align-items: center; margin-top: 6px; }

/* journal */
.toolbar { display: flex; gap: 8px; }
.search {
  flex: 1; background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; font: inherit;
  transition: border-color 150ms ease;
}
.search:focus { outline: none; border-color: var(--accent); }
.kind-select {
  background: var(--surface); color: var(--text-2); border: 1px solid var(--border);
  border-radius: 10px; padding: 8px 10px; font: inherit;
}
.j-list { display: flex; flex-direction: column; gap: 8px; }
.j-entry { background: var(--card); border: 1px solid var(--border); border-radius: 12px; }
.j-head { display: flex; gap: 10px; align-items: baseline; padding: 12px 16px; cursor: pointer; }
.j-head:hover { background: var(--hover); border-radius: 12px; }
.j-body { padding: 4px 16px 14px; display: flex; flex-direction: column; gap: 10px; }
.q-block { border-left: 2px solid var(--accent); padding-left: 12px; }
.btn {
  align-self: start; background: none; border: 1px solid var(--border); color: var(--text-2);
  border-radius: 8px; padding: 5px 12px; cursor: pointer; font: inherit; font-size: 12.5px;
  transition: border-color 150ms ease, color 150ms ease;
}
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.more { align-self: center; }

/* diff — additions carry the accent, deletions recede; still three hues */
.diff {
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; line-height: 1.5;
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 10px 0; overflow-x: auto;
}
.dline { padding: 0 14px; white-space: pre; color: var(--text-2); }
.dline.add { background: var(--accent-soft); color: var(--accent-strong); }
.dline.del { opacity: 0.45; }
.dline.hunk { color: var(--text-3); padding-top: 6px; }

/* knowledge */
.k-row { padding: 10px 0; border-top: 1px solid var(--border); }
.k-row:first-of-type { border-top: 0; }
.k-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.k-body { margin-top: 4px; }
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test dashboard.test.ts`
Expected: 10 pass, 0 fail.

- [ ] **Step 6: Manual visual check against the real DB**

Run: `bun dashboard.ts --open` (real `~/.anakin`, read-only — safe). Walk all five views in both themes; verify empty states by also starting once with `ANAKIN_HOME` pointed at an empty temp dir. Fix visual nits inline.

- [ ] **Step 7: Commit**

```bash
cd /Users/boyan.balev/projects/agentique
git add skills/anakin/scripts/dashboard/
git commit -m "feat(anakin): dashboard project views — task, journal with diffs, knowledge, gate"
```

---

### Task 4: Snapshot mode

**Files:**
- Modify: `skills/anakin/scripts/dashboard.ts` (insert snapshot branch between `const argv = flags(...)` and the port handling)
- Test: extend `skills/anakin/scripts/dashboard.test.ts`

**Interfaces:**
- Consumes: `overview()`, `projectPayload()`, `journalPage()`, `INDEX_HTML`, `CSS`, `APP_JS` from Task 1; `window.__SNAPSHOT__` consumption already in `app.ts`.
- Produces: `--snapshot [file]` flag writing a self-contained HTML file; prints `anakin dashboard snapshot <abs path>`.

- [ ] **Step 1: Write the failing tests** (append to `dashboard.test.ts`)

```ts
import { readFileSync } from "node:fs";

describe("snapshot", () => {
  function runDash(args: string[]) {
    const p = Bun.spawnSync(["bun", DASH, ...args], {
      env: { ...process.env, ANAKIN_HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  }

  test("writes one self-contained file with data inlined and escaped", () => {
    const { repo, task } = seed();
    run(["journal", "append", "--repo", repo],
      JSON.stringify({ task_id: task.id, entry_kind: "note",
        decisions: "tried <script>alert(1)</script> in a decision" }));
    const out = join(home, "snap.html");
    const r = runDash(["--snapshot", out]);
    expect(r.code).toBe(0);
    const html = readFileSync(out, "utf8");
    expect(html).toContain("window.__SNAPSHOT__");
    expect(html).toContain("oklch(");
    // raw script tag from DB data must never appear unescaped
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("\\u003cscript>alert(1)");
    // self-contained: no external refs beyond XML namespaces
    const refs = html.match(/https?:\/\/[^"'`\s<>)]+/g) ?? [];
    expect(refs.every((x) => x.startsWith("http://www.w3.org/"))).toBe(true);
  });

  test("snapshot with no DB still writes a working empty page", () => {
    const out = join(home, "empty.html");
    const r = runDash(["--snapshot", out]);
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("window.__SNAPSHOT__");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test dashboard.test.ts`
Expected: snapshot tests FAIL (server starts and hangs is prevented because `--snapshot` is unknown → server mode; the spawnSync returns only after timeout kill — if it hangs, that IS the failure; proceed).

If `runDash` hangs because the server starts, add `timeout: 5000` to the `Bun.spawnSync` options in `runDash` while the feature is missing; remove nothing afterward — the option is harmless once `--snapshot` exits promptly.

- [ ] **Step 3: Implement the snapshot branch in `dashboard.ts`**

Insert immediately after `const argv = flags(process.argv.slice(2));`:

```ts
if (argv.snapshot !== undefined) {
  const outFile = typeof argv.snapshot === "string" ? argv.snapshot : "anakin-dashboard.html";
  const db = openDb();
  const o = overview(db) as any;
  const projects: Record<string, unknown> = {};
  const journal: Record<string, unknown> = {};
  const patches: Record<string, string> = {};
  if (db) {
    for (const p of o.projects as any[]) {
      projects[p.id] = projectPayload(db, p.id);
      const all = journalPage(db, p.id, { limit: 10000 }).entries;
      journal[p.id] = all;
      for (const e of all) if (e.has_patch) {
        const row = db.query("SELECT patch FROM journal WHERE id = ?").get(e.id) as any;
        patches[String(e.id)] = row?.patch ?? "";
      }
    }
    db.close();
  }
  const data = { overview: o, projects, journal, patches };
  // <-escape so DB content can never terminate the inline script tag.
  const html = INDEX_HTML
    .replace('<link rel="stylesheet" href="/style.css">', () => `<style>\n${CSS}\n</style>`)
    .replace('<script type="module" src="/app.js"></script>', () =>
      `<script>window.__SNAPSHOT__=${JSON.stringify(data).replace(/</g, "\\u003c")}</script>\n<script type="module">\n${APP_JS}\n</script>`);
  writeFileSync(outFile, html);
  console.log(`anakin dashboard snapshot ${resolve(outFile)}`);
  process.exit(0);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test dashboard.test.ts`
Expected: 12 pass, 0 fail.

- [ ] **Step 5: Manual check**

Run: `bun dashboard.ts --snapshot /tmp/anakin-snap.html && open /tmp/anakin-snap.html` — all views render offline, "snapshot" badge visible in the rail, patches expand without a server.

- [ ] **Step 6: Commit**

```bash
cd /Users/boyan.balev/projects/agentique
git add skills/anakin/scripts/dashboard.ts skills/anakin/scripts/dashboard.test.ts
git commit -m "feat(anakin): dashboard --snapshot writes a self-contained HTML observatory"
```

---

### Task 5: Skill wiring and docs

**Files:**
- Modify: `skills/anakin/commands/anakin.md` (add `dashboard` arg)
- Modify: `skills/anakin/SKILL.md` (one line under requirements/phases)
- Modify: `README.md` (mention the dashboard in the anakin section)

**Interfaces:**
- Consumes: the Task 1 startup line `anakin dashboard http://127.0.0.1:<port> pid <pid>`.
- Produces: `/anakin dashboard` behavior documented for the agent.

- [ ] **Step 1: Add the `dashboard` arg to `commands/anakin.md`**

In the args section (alongside `init`, `task <text>`, `harden`, `status`, `import`), add:

```markdown
- `dashboard` — start the read-only observatory: run
  `bun <skill>/scripts/dashboard.ts --open` as a background process, then tell
  the human the URL and PID from its startup line
  (`anakin dashboard http://127.0.0.1:<port> pid <pid>`) and how to stop it
  (`kill <pid>`). Do not schedule wakeups for it; it is not a factory phase.
  `--snapshot <file>` instead writes a self-contained HTML snapshot for
  sharing. The dashboard opens the DB read-only and can never alter memory.
```

- [ ] **Step 2: Add one line to `SKILL.md`**

Under the DB/CLI memory section (or requirements), add:

```markdown
A read-only dashboard over the same DB ships with the skill
(`scripts/dashboard.ts`; `/anakin dashboard`) — an observatory for the human,
never a write path.
```

- [ ] **Step 3: Update `README.md`**

In the anakin section, extend the bullet describing v2 with: `+ a read-only local dashboard (\`/anakin dashboard\`) over the same DB`, and add `dashboard.ts` + `dashboard/` to the repo layout tree under `skills/anakin/scripts/`.

- [ ] **Step 4: Full gate**

Run: `cd skills/anakin/scripts && bun test`
Expected: 31 pass, 0 fail.
Run: `grep -rn "innerHTML" skills/anakin/scripts/dashboard/` → no matches.
Run: `grep -c "oklch(" skills/anakin/scripts/dashboard/style.css` → all colors in the token blocks only (spot-check: no `#hex`, no `rgb(` outside tokens: `grep -n "#[0-9a-fA-F]\{3\}\|rgb(" skills/anakin/scripts/dashboard/style.css` → no matches).

- [ ] **Step 5: Commit**

```bash
cd /Users/boyan.balev/projects/agentique
git add skills/anakin/commands/anakin.md skills/anakin/SKILL.md README.md
git commit -m "docs(anakin): wire /anakin dashboard into the skill"
```

---

## Verification against the spec

- Spec §CLI: port/open/snapshot flags, startup line, Ctrl+C stop → Tasks 1, 4.
- Spec §HTTP surface: all six routes + 404/500/503 + busy retry → Task 1.
- Spec §Security: 127.0.0.1, CSP, textContent-only, param validation → Tasks 1–3, checked in Task 5 gate.
- Spec §Visual system: OKLCH tokens, three hues, both themes, glyph verdicts, diff palette → Tasks 2–3.
- Spec §Views: all five + empty states → Tasks 2–3.
- Spec §Frontend: h()/router/poll/snapshot detection → Tasks 2–4.
- Spec §Testing: every listed test exists across Tasks 1–4.
- Spec §Acceptance: 1→Task 5 gate; 2→Task 3 manual; 3→Task 4 manual; 4→Task 1 (readonly + GET-only tests); 5→Task 3 manual both themes; 6→Task 5.
