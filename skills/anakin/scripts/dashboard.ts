#!/usr/bin/env bun
// anakin dashboard — read-only observatory over the factory memory.
// GET-only JSON API + static UI on 127.0.0.1; never writes to the DB.
// Zero npm dependencies.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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

// A DB that only ever met the v1 CLI has no mission tables; the dashboard is
// read-only and must not create them, so every mission query checks first.
function hasTable(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
}

// Questions count as "waiting on you" only while their task is active —
// task-less or committed-task questions would otherwise accrete forever
// (the journal is append-only; nothing could ever clear them).
const OPEN_Q_WHERE = `j.questions != '' AND t.status IN ('approved','in_progress','review')`;

function overview(db: Database | null) {
  if (!db) return { empty: true, projects: [], recent: [], questions: [],
    totals: { projects: 0, tasks_by_status: {}, ticks_7d: 0, ticks_30d_by_day: [], open_questions: 0 } };
  const projects = db.query(`
    SELECT p.id, p.name, p.abs_path, p.origin_url,
      (SELECT title  FROM tasks WHERE project_id = p.id AND status IN ('approved','in_progress','review') ORDER BY id DESC LIMIT 1) AS active_task,
      (SELECT MAX(created_at) FROM journal WHERE project_id = p.id) AS last_activity
    FROM projects p
    ORDER BY last_activity IS NULL, last_activity DESC`).all();
  const tasksByStatus: Record<string, number> = {};
  for (const r of db.query("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status").all() as any[])
    tasksByStatus[r.status] = r.c;
  const totals = {
    projects: projects.length,
    tasks_by_status: tasksByStatus,
    // Velocity = entries that recorded the tree: v1 ticks and v2 mission
    // checkpoints/closes alike, so the curve stays monotone across eras.
    ticks_7d: (db.query("SELECT COUNT(*) AS c FROM journal WHERE tree_hash IS NOT NULL AND created_at >= datetime('now','-7 days')").get() as any).c,
    ticks_30d_by_day: db.query("SELECT date(created_at) AS d, COUNT(*) AS c FROM journal WHERE tree_hash IS NOT NULL AND created_at >= datetime('now','-30 days') GROUP BY d ORDER BY d").all(),
    open_questions: (db.query(`SELECT COUNT(*) AS c FROM journal j
      JOIN tasks t ON t.id = j.task_id WHERE ${OPEN_Q_WHERE}`).get() as any).c,
  };
  const recent = db.query(`
    SELECT j.id, j.project_id, p.name AS project_name, j.entry_kind, j.gate_verdict,
           substr(j.decisions, 1, 200) AS decisions, i.title AS item_title, j.created_at
    FROM journal j JOIN projects p ON p.id = j.project_id LEFT JOIN items i ON i.id = j.item_id
    ORDER BY j.id DESC LIMIT 20`).all();
  const questions = db.query(`
    SELECT j.id, j.project_id, p.name AS project_name, t.title AS task_title, j.questions, j.created_at
    FROM journal j JOIN tasks t ON t.id = j.task_id JOIN projects p ON p.id = j.project_id
    WHERE ${OPEN_Q_WHERE}
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
      // Scoped to the viewed project and newest-first, so the cap drops the
      // oldest hits deterministically instead of an arbitrary cross-project set.
      rowids = (db.query(`SELECT f.rowid AS rowid FROM journal_fts f
          JOIN journal jf ON jf.id = f.rowid
          WHERE journal_fts MATCH ? AND jf.project_id = ?
          ORDER BY f.rowid DESC LIMIT 500`)
        .all(match, projectId) as any[]).map((r) => r.rowid);
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
    ? db.query("SELECT head_sha, tree_hash FROM journal WHERE task_id = ? AND tree_hash IS NOT NULL ORDER BY id DESC LIMIT 1").get((task as any).id)
    : null;
  const missions = hasTable(db, "missions")
    ? (db.query(`SELECT m.*, t.title AS task_title FROM missions m JOIN tasks t ON t.id = m.task_id
                 WHERE t.project_id = ? ORDER BY m.id DESC`).all(id) as any[]).map((m) => ({
        ...m,
        stage_plan: JSON.parse(m.stage_plan),
        handoffs: db.query(`SELECT id, stage, attempt, verdict, content, created_at
                            FROM handoffs WHERE mission_id = ? ORDER BY id`).all(m.id),
        artifacts: db.query(`SELECT id, filename, length(body) AS bytes, created_at
                             FROM artifacts WHERE mission_id = ? ORDER BY filename`).all(m.id),
      }))
    : [];
  return {
    project, task, items, missions,
    gate: db.query("SELECT ordinal, command, reason FROM gate_commands WHERE project_id = ? ORDER BY ordinal").all(id),
    knowledge: db.query("SELECT * FROM knowledge_sections WHERE project_id = ? ORDER BY kind, title").all(id),
    prefs: db.query("SELECT key, body FROM prefs ORDER BY key").all(),
    expected_head_sha: lastTick?.head_sha ?? null,
    expected_tree_hash: lastTick?.tree_hash ?? null,
    journal: journalPage(db, id, {}).entries,
  };
}

// The seq must move for ANY visible change — including tables with no
// timestamps (gate_commands, prefs), body-only knowledge upserts, new
// projects, and status/cursor flips landing in the same second as the write
// before them (datetime('now') is second-granular) — so it digests content,
// not just counts and timestamps. Journal/handoffs/artifacts are append-only,
// so MAX(id) suffices for the big tables.
function version(db: Database | null) {
  if (!db) return { seq: "empty" };
  const parts = db.query(`SELECT
      (SELECT COALESCE(MAX(id), 0) FROM journal) AS j,
      (SELECT COALESCE(GROUP_CONCAT(x), '') FROM
        (SELECT id || ':' || status || ':' || updated_at AS x FROM tasks ORDER BY id)) AS t,
      (SELECT COUNT(*) || '-' || COALESCE(SUM(CASE status WHEN 'done' THEN 1 ELSE 0 END), 0) FROM items) AS i,
      (SELECT COUNT(*) || '-' || COALESCE(MAX(updated_at), '') || '-' ||
              COALESCE(SUM(length(body) + length(paths_glob)), 0) FROM knowledge_sections) AS k,
      (SELECT COALESCE(GROUP_CONCAT(x), '') FROM
        (SELECT id || ':' || abs_path || ':' || name AS x FROM projects ORDER BY id)) AS p,
      (SELECT COALESCE(GROUP_CONCAT(x), '') FROM
        (SELECT project_id || ':' || ordinal || ':' || command || ':' || reason AS x
         FROM gate_commands ORDER BY project_id, ordinal)) AS g,
      (SELECT COALESCE(GROUP_CONCAT(x), '') FROM
        (SELECT key || ':' || body AS x FROM prefs ORDER BY key)) AS pr`).get();
  const missions = hasTable(db, "missions")
    ? db.query(`SELECT
        (SELECT COALESCE(GROUP_CONCAT(x), '') FROM
          (SELECT id || ':' || status || ':' || stage_cursor || ':' || updated_at AS x
           FROM missions ORDER BY id)) AS m,
        (SELECT COALESCE(MAX(id), 0) FROM handoffs) AS h,
        (SELECT COALESCE(MAX(id), 0) FROM artifacts) AS a`).get()
    : null;
  return { seq: createHash("sha256").update(JSON.stringify([parts, missions])).digest("hex").slice(0, 16) };
}

// ---------- http ----------

const INDEX_HTML = readFileSync(join(UI_DIR, "index.html"), "utf8");
const CSS = readFileSync(join(UI_DIR, "style.css"), "utf8");
const THEME_JS = readFileSync(join(UI_DIR, "theme.js"), "utf8");
const build = await Bun.build({ entrypoints: [join(UI_DIR, "app.ts")], target: "browser" });
if (!build.success) {
  console.error("app.ts failed to build:\n" + build.logs.join("\n"));
  process.exit(1);
}
const APP_JS = await build.outputs[0].text();

function json(x: unknown, status = 200): Response {
  return new Response(JSON.stringify(x),
    { status, headers: { "content-type": "application/json", "x-content-type-options": "nosniff" } });
}

// The 127.0.0.1 binding alone doesn't stop DNS rebinding: a hostile page on a
// domain rebound to 127.0.0.1 becomes same-origin and could read the factory
// memory. Refuse any request whose Host isn't a loopback name.
const HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (!HOST_RE.test(req.headers.get("host") ?? "")) return json({ error: "bad host" }, 403);
  if (req.method !== "GET") return json({ error: "read-only" }, 405);
  // no-store: heuristic caching would otherwise mix an old app.js or
  // style.css with a new server after an upgrade — the assets are tiny.
  const asset = (body: string, type: string, extra: Record<string, string> = {}) =>
    new Response(body, { headers: { "content-type": `${type}; charset=utf-8`,
      "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra } });
  if (p === "/") return asset(INDEX_HTML, "text/html", { "content-security-policy": CSP });
  if (p === "/style.css") return asset(CSS, "text/css");
  if (p === "/app.js") return asset(APP_JS, "text/javascript");
  if (p === "/theme.js") return asset(THEME_JS, "text/javascript");
  if (!p.startsWith("/api/")) return json({ error: "not found" }, 404);
  let db: Database | null = null;
  try {
    db = openDb(); // inside the try: an unopenable DB must yield JSON, not an HTML error page
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
      return new Response(row.patch,
        { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
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
    .replace('<script src="/theme.js"></script>', () => `<script>\n${THEME_JS}\n</script>`)
    .replace('<link rel="stylesheet" href="/style.css">', () => `<style>\n${CSS}\n</style>`)
    .replace('<script type="module" src="/app.js"></script>', () =>
      `<script>window.__SNAPSHOT__=${JSON.stringify(data).replace(/</g, "\\u003c")}</script>\n<script type="module">\n${APP_JS}\n</script>`);
  writeFileSync(outFile, html);
  console.log(`anakin dashboard snapshot ${resolve(outFile)}`);
  process.exit(0);
}

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
