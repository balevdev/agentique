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
