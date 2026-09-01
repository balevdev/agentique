#!/usr/bin/env bun
// anakin-db — the only read/write path to ANAKIN's global memory.
// I/O helper, not an enforcement engine. Zero npm dependencies.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const HOME = process.env.ANAKIN_HOME ?? join(process.env.HOME ?? "", ".anakin");
const DB_PATH = join(HOME, "anakin.db");
const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

// ---------- helpers ----------

function openDb(): Database {
  mkdirSync(HOME, { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrateArtifactsFts(db);
  return db;
}

// v2 first shipped artifacts_fts contentless (content=''), which cannot delete
// rows: re-ingests left stale rowids behind and rowid reuse merged bodies
// across artifacts. Rebuild it as external content over the artifacts table —
// atomically, or a crash mid-migration leaves the index dropped or empty and
// the next open (whose CREATE IF NOT EXISTS no longer matches the contentless
// check) would never rebuild it.
function migrateArtifactsFts(db: Database) {
  const row = db.query("SELECT sql FROM sqlite_master WHERE name = 'artifacts_fts'").get() as any;
  if (!row?.sql?.includes("content=''")) return;
  db.exec(`BEGIN;
    DROP TABLE artifacts_fts;
    CREATE VIRTUAL TABLE artifacts_fts USING fts5(filename, body, content='artifacts', content_rowid='id');
    INSERT INTO artifacts_fts(artifacts_fts) VALUES ('rebuild');
    COMMIT;`);
}

function sh(cwd: string, cmd: string[]): string | null {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
}

const hash16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function normalizeOrigin(url: string): string {
  return url
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^git@/, "")
    .replace(/^[^@/]*@/, "")
    .replace(":", "/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

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

async function stdinJson(): Promise<any> {
  const t = (await Bun.stdin.text()).trim();
  return t ? JSON.parse(t) : {};
}

function out(x: unknown) { console.log(JSON.stringify(x, null, 2)); }

function die(msg: string): never { console.error(msg); process.exit(1); }

function spool(cmd: string, payload: unknown): never {
  const dir = join(HOME, "spool");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${stamp}-${cmd}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  console.error(`DB write failed; payload spooled to ${file}`);
  process.exit(1);
}

type Project = { id: string; origin_url: string | null; abs_path: string; name: string };

function projectFor(db: Database, repo: string, createIfMissing = true): Project | null {
  const abs = resolve(repo);
  const originRaw = sh(abs, ["git", "-C", abs, "remote", "get-url", "origin"]);
  const origin = originRaw ? normalizeOrigin(originRaw) : null;
  let row = origin
    ? (db.query("SELECT * FROM projects WHERE origin_url = ?").get(origin) as Project | null)
    : null;
  if (!row) row = db.query("SELECT * FROM projects WHERE abs_path = ?").get(abs) as Project | null;
  if (row) {
    db.run("UPDATE projects SET abs_path = ?, origin_url = COALESCE(?, origin_url) WHERE id = ?",
      [abs, origin, row.id]);
    return db.query("SELECT * FROM projects WHERE id = ?").get(row.id) as Project;
  }
  if (!createIfMissing) return null;
  const id = hash16(origin ?? abs);
  db.run("INSERT INTO projects (id, origin_url, abs_path, name) VALUES (?,?,?,?)",
    [id, origin, abs, basename(abs)]);
  return db.query("SELECT * FROM projects WHERE id = ?").get(id) as Project;
}

// Read commands never register a project — an unknown repo routes to init.
function readProject(db: Database, repo: string): Project {
  const p = projectFor(db, repo, false);
  if (!p) die("no project registered for this repo — run init first");
  return p;
}

// close and ingest address a mission by its dir (the mission id may be lost
// along with the context that opened it).
function missionByDir(db: Database, p: Project, dir: any, sub: string): { mrow: any; absDir: string } {
  if (typeof dir !== "string" || !dir) die(`mission ${sub} requires --dir <mission dir>`);
  const mrow = db.query(`SELECT m.* FROM missions m JOIN tasks t ON t.id = m.task_id
                         WHERE t.project_id = ? AND m.dir = ? ORDER BY m.id DESC LIMIT 1`)
    .get(p.id, dir) as any;
  if (!mrow) die(`no mission with dir ${dir} in this project`);
  const absDir = resolve(p.abs_path, dir);
  if (!existsSync(absDir)) die(`mission dir not found at ${absDir}`);
  return { mrow, absDir };
}

// A bare flag parses to `true` and Number(true) === 1 — a silent wrong-row id.
// Numeric flags must be explicit digit strings.
function intFlag(argv: Record<string, any>, name: string): number {
  const v = argv[name];
  if (typeof v !== "string" || !/^\d+$/.test(v)) die(`--${name} requires a numeric value`);
  return Number(v);
}

function changes(db: Database): number {
  return (db.query("SELECT changes() AS c").get() as any).c;
}

function activeTask(db: Database, projectId: string): any | null {
  return db.query(`SELECT * FROM tasks WHERE project_id = ?
                   AND status IN ('approved','in_progress','review')
                   ORDER BY id DESC LIMIT 1`).get(projectId) ?? null;
}

function activeMission(db: Database, projectId: string): any | null {
  return db.query(`SELECT m.* FROM missions m JOIN tasks t ON t.id = m.task_id
                   WHERE t.project_id = ? AND m.status = 'running'
                   ORDER BY m.id DESC LIMIT 1`).get(projectId) ?? null;
}

function missionWithHandoffs(db: Database, mrow: any): any {
  return {
    ...mrow,
    stage_plan: JSON.parse(mrow.stage_plan),
    handoffs: db.query(`SELECT id, stage, attempt, verdict, content, created_at
                        FROM handoffs WHERE mission_id = ? ORDER BY id`).all(mrow.id),
  };
}

// Replace each file's prior copy inside the caller's transaction. artifacts_fts
// is external content: it must be told about a delete, with the old row's
// values, before the row itself goes away.
function ingestArtifacts(db: Database, missionId: number, absDir: string, files: string[]) {
  for (const f of files) {
    const old = db.query("SELECT id, filename, body FROM artifacts WHERE mission_id = ? AND filename = ?")
      .get(missionId, f) as any;
    if (old) {
      db.run("INSERT INTO artifacts_fts (artifacts_fts, rowid, filename, body) VALUES ('delete', ?, ?, ?)",
        [old.id, old.filename, old.body]);
      db.run("DELETE FROM artifacts WHERE id = ?", [old.id]);
    }
    const body = readFileSync(join(absDir, f), "utf8");
    db.run("INSERT INTO artifacts (mission_id, filename, body) VALUES (?,?,?)", [missionId, f, body]);
    const aid = (db.query("SELECT last_insert_rowid() AS id").get() as any).id;
    db.run("INSERT INTO artifacts_fts (rowid, filename, body) VALUES (?,?,?)", [aid, f, body]);
  }
}

// Tokenize prose into an FTS OR-query; returns null when nothing searchable.
// Unicode letters/digits stay — FTS5's unicode61 tokenizer indexes them, so a
// task written in French or Cyrillic must still recall its own history.
function ftsQuery(text: string): string | null {
  const tokens = text.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(w => w.length > 2);
  return tokens.length ? tokens.map(t => `"${t}"`).join(" OR ") : null;
}

function globToRe(glob: string): RegExp {
  const esc = glob.trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]") // glob ?, not a regex quantifier - unescaped, a leading "?" even throws
    .replace(/\u0001/g, ".*");
  return new RegExp(`^${esc}$`);
}

function globsCover(globsCsv: string, paths: string[]): boolean {
  const res = globsCsv.split(",").map(g => g.trim()).filter(Boolean).map(globToRe);
  if (res.length === 0) return false;
  return paths.some(p => res.some(re => re.test(p)));
}

function isStale(repo: string, verified: string | null, globsCsv: string): boolean {
  if (!verified) return true;
  const paths = globsCsv.split(",").map(g => g.trim()).filter(Boolean);
  const outp = sh(repo, ["git", "-C", repo, "rev-list", `${verified}..HEAD`, "--",
    ...(paths.length ? paths : ["."])]);
  return outp === null ? true : outp.length > 0;
}

// ---------- legacy .anakin/ import parsers ----------

const KIND_MAP: Record<string, string> = {
  layout: "layout", boundaries: "boundary", boundary: "boundary",
  conventions: "convention", convention: "convention",
  "sensitive zones": "sensitive_zone", sensitive: "sensitive_zone",
  gotchas: "gotcha", gotcha: "gotcha",
};

function parseGateMd(text: string): { command: string; reason: string }[] {
  const rows: { command: string; reason: string }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^[-*]\s+`?([^`—]+?)`?\s*(?:—\s*(.*))?$/);
    if (m && m[1].trim()) rows.push({ command: m[1].trim(), reason: (m[2] ?? "").trim() });
  }
  return rows;
}

function parseKnowledgeMd(text: string): { kind: string; title: string; body: string; verified_sha: string | null }[] {
  const sections: { kind: string; title: string; body: string; verified_sha: string | null }[] = [];
  const parts = text.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = part.slice(0, nl).trim();
    let body = part.slice(nl + 1).trim();
    const kind = KIND_MAP[heading.toLowerCase()] ?? "gotcha";
    const vm = body.match(/verified:\s*([0-9a-f]{6,40})/i);
    if (vm) body = body.replace(vm[0], "").trim();
    sections.push({ kind, title: heading, body, verified_sha: vm ? vm[1] : null });
  }
  return sections;
}

function parseRoadmapMd(text: string) {
  const items: any[] = [];
  let current: any = null;
  for (const line of text.split("\n")) {
    const im = line.match(/^- \[( |x)\]\s+(?:\d+\.\s+)?(.+)$/);
    if (im) {
      current = { done: im[1] === "x", title: im[2].trim(), files: "", done_when: "", contract: null, sensitive: null };
      items.push(current);
    } else if (current) {
      const fm = line.match(/^\s+(files|done-when|contract|sensitive):\s*(.+)$/);
      if (fm) {
        const key = fm[1] === "done-when" ? "done_when" : fm[1];
        current[key] = fm[2].trim();
      }
    }
  }
  return items;
}

function parseJournalMd(text: string): { title: string; body: string }[] {
  return text.split(/^## /m).slice(1).map(part => {
    const nl = part.indexOf("\n");
    return { title: part.slice(0, nl).trim(), body: part.slice(nl + 1).trim() };
  });
}

// ---------- subcommands ----------

async function main() {
  const argv = flags(process.argv.slice(2));
  const [cmd, sub] = argv._;
  const repo = argv.repo as string | undefined;

  switch (cmd) {
    case "init": {
      if (!repo) die("init requires --repo <path>");
      try {
        const db = openDb();
        out(projectFor(db, repo));
      } catch (e) {
        spool("init", { repo, error: String(e) });
      }
      return;
    }
    case "task": {
      if (!repo) die("task requires --repo <path>");
      if (sub === "new") {
        const t = await stdinJson();
        try {
          const db = openDb();
          const p = projectFor(db, repo)!;
          if (activeTask(db, p.id)) die("an active task already exists; close or commit it first (one task at a time)");
          // stage_plan travels inside mini_spec (no tasks column — YAGNI); it is
          // restated verbatim to `mission open` when the mission starts.
          let miniSpec = t.mini_spec ?? "";
          if (Array.isArray(t.stage_plan) && t.stage_plan.length)
            miniSpec = (miniSpec ? miniSpec + "\n\n" : "") + `stage_plan: ${JSON.stringify(t.stage_plan)}`;
          db.run("INSERT INTO tasks (project_id, title, description, mini_spec) VALUES (?,?,?,?)",
            [p.id, t.title ?? "(untitled)", t.description ?? "", miniSpec]);
          out(db.query("SELECT * FROM tasks WHERE id = last_insert_rowid()").get());
        } catch (e) { spool("task-new", { repo, task: t, error: String(e) }); }
      } else if (sub === "show") {
        const db = openDb();
        const p = readProject(db, repo);
        const row = argv.id !== undefined
          ? db.query("SELECT * FROM tasks WHERE id = ? AND project_id = ?").get(intFlag(argv, "id"), p.id)
          : activeTask(db, p.id);
        out(row ?? null);
      } else if (sub === "approve") {
        const id = intFlag(argv, "id");
        try {
          const db = openDb();
          const p = projectFor(db, repo)!;
          const head = sh(p.abs_path, ["git", "-C", p.abs_path, "rev-parse", "HEAD"]);
          if (!head) console.error("warning: no git HEAD here — baseline_sha will be null and close-time diffs will have no baseline");
          db.run(`UPDATE tasks SET status = 'approved', baseline_sha = ?, updated_at = datetime('now')
                  WHERE id = ? AND project_id = ? AND status = 'draft'`,
            [head, id, p.id]);
          if (!changes(db)) die(`task ${id} is not a draft (approve only moves draft → approved)`);
          out(db.query("SELECT * FROM tasks WHERE id = ?").get(id));
        } catch (e) { spool("task-approve", { repo, id, error: String(e) }); }
      } else if (sub === "close") {
        const id = intFlag(argv, "id");
        try {
          const db = openDb();
          const p = projectFor(db, repo)!;
          // A task must not slip into review over a live mission: recall
          // reconciles task states but never missions, so the orphan would
          // show as "running" forever.
          if (db.query("SELECT id FROM missions WHERE task_id = ? AND status = 'running'").get(id))
            die(`task ${id} still has a running mission — mission close (or mission stop) first`);
          db.run(`UPDATE tasks SET status = 'review', updated_at = datetime('now')
                  WHERE id = ? AND project_id = ? AND status IN ('approved','in_progress')`,
            [id, p.id]);
          if (!changes(db)) die(`task ${id} is not approved/in_progress (close only moves those → review)`);
          out(db.query("SELECT * FROM tasks WHERE id = ?").get(id));
        } catch (e) { spool("task-close", { repo, id, error: String(e) }); }
      } else if (sub === "status") {
        const db = openDb();
        const p = readProject(db, repo);
        out({ project: p, active: activeTask(db, p.id) });
      } else die("task new|show|approve|close|status");
      return;
    }

    case "item": {
      if (!repo) die("item requires --repo <path>");
      if (sub === "add") {
        const taskId = intFlag(argv, "task");
        const it = await stdinJson();
        try {
          const db = openDb();
          projectFor(db, repo);
          db.run(`INSERT INTO items (task_id, ordinal, title, files, done_when, contract, sensitive)
                  VALUES (?,?,?,?,?,?,?)`,
            [taskId, it.ordinal, it.title, it.files ?? "", it.done_when ?? "", it.contract ?? null, it.sensitive ?? null]);
          out(db.query("SELECT * FROM items WHERE id = last_insert_rowid()").get());
        } catch (e) { spool("item-add", { repo, taskId, item: it, error: String(e) }); }
      } else if (sub === "list") {
        const taskId = intFlag(argv, "task");
        const db = openDb();
        out(db.query("SELECT * FROM items WHERE task_id = ? ORDER BY ordinal").all(taskId));
      } else if (sub === "check") {
        const id = intFlag(argv, "id");
        const journalId = argv.journal === undefined ? null : intFlag(argv, "journal");
        try {
          const db = openDb();
          const p = projectFor(db, repo)!;
          db.run(`UPDATE items SET status = 'done', journal_id = ?
                  WHERE id = ? AND task_id IN (SELECT id FROM tasks WHERE project_id = ?)`,
            [journalId, id, p.id]);
          if (!changes(db)) die(`no item ${id} in this project`);
          out(db.query("SELECT * FROM items WHERE id = ?").get(id));
        } catch (e) { spool("item-check", { repo, id, journalId, error: String(e) }); }
      } else die("item add|list|check");
      return;
    }

    case "mission": {
      if (!repo) die("mission requires --repo <path>");
      if (sub === "open") {
        const m = await stdinJson(); // {task_id, slug, stage_plan, dir}
        try {
          const db = openDb();
          const p = projectFor(db, repo)!;
          const task = db.query("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
            .get(m.task_id, p.id) as any;
          if (!task) die(`no task ${m.task_id} in this project`);
          if (task.status !== "approved" && task.status !== "in_progress")
            die(`task ${m.task_id} is ${task.status} — a mission needs an approved task`);
          if (db.query("SELECT id FROM missions WHERE task_id = ? AND status = 'running'").get(m.task_id))
            die(`task ${m.task_id} already has a running mission — resume it (mission show), don't reopen`);
          if (!Array.isArray(m.stage_plan) || m.stage_plan.length === 0)
            die("stage_plan must be a non-empty JSON array of stage names");
          // The plan the human approved travels in the mini_spec; a mission may
          // not quietly open with a different one. task new APPENDS its line,
          // so the last match wins — spec prose above may mention stage_plan too.
          const approved = [...task.mini_spec.matchAll(/^stage_plan: (\[.*\])$/gm)].at(-1);
          if (approved && JSON.stringify(m.stage_plan) !== approved[1])
            die(`stage_plan ${JSON.stringify(m.stage_plan)} differs from the approved plan ${approved[1]} in the mini-spec`);
          if (typeof m.slug !== "string" || !m.slug || typeof m.dir !== "string" || !m.dir)
            die("mission open requires slug and dir");
          let row: any;
          db.transaction(() => {
            db.run("INSERT INTO missions (task_id, slug, stage_plan, dir) VALUES (?,?,?,?)",
              [m.task_id, m.slug, JSON.stringify(m.stage_plan), m.dir]);
            row = db.query("SELECT * FROM missions WHERE id = last_insert_rowid()").get();
            db.run("UPDATE tasks SET status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND status = 'approved'",
              [m.task_id]);
          })();
          out(row);
        } catch (e) { spool("mission-open", { repo, mission: m, error: String(e) }); }
      } else if (sub === "stage") {
        const s = await stdinJson(); // {mission_id, stage, attempt, verdict?, content}
        try {
          const db = openDb();
          const p = projectFor(db, repo)!;
          const mrow = db.query(`SELECT m.* FROM missions m JOIN tasks t ON t.id = m.task_id
                                 WHERE m.id = ? AND t.project_id = ?`).get(s.mission_id, p.id) as any;
          if (!mrow) die(`no mission ${s.mission_id} in this project`);
          if (mrow.status !== "running") die(`mission ${s.mission_id} is ${mrow.status}, not running`);
          const idx = (JSON.parse(mrow.stage_plan) as string[]).indexOf(s.stage);
          // An audit can be dispatched ad hoc (sensitive-zone drift) even when
          // the plan lacks it; it is recorded without moving the cursor.
          const adHocAudit = idx < 0 && s.stage === "audit";
          if (idx < 0 && !adHocAudit)
            die(`stage "${s.stage}" is not in this mission's stage_plan ${mrow.stage_plan}`);
          if (typeof s.content !== "string" || !s.content.trim())
            die("stage requires non-empty content (the handoff, verbatim)");
          // A failing verdict holds the cursor on the failed stage, so a crash
          // resumes inside the fix loop instead of past it. The leading token
          // decides — verdicts are free text; "FAIL — 2 defects" must not pass.
          const failed = typeof s.verdict === "string" && /^\s*(fail|block|red)\b/i.test(s.verdict);
          // The cursor advances one stage at a time or resets backward into a
          // fix loop; a stage recorded ahead of it (an early in-plan audit)
          // must never drag it forward past unexecuted stages.
          const cursor = adHocAudit || idx > mrow.stage_cursor ? mrow.stage_cursor
            : failed ? idx : idx + 1;
          let row: any;
          db.transaction(() => {
            db.run("INSERT INTO handoffs (mission_id, stage, attempt, verdict, content) VALUES (?,?,?,?,?)",
              [s.mission_id, s.stage, s.attempt ?? 1, s.verdict ?? null, s.content]);
            row = db.query("SELECT * FROM handoffs WHERE id = last_insert_rowid()").get();
            db.run("UPDATE missions SET stage_cursor = ?, updated_at = datetime('now') WHERE id = ?",
              [cursor, s.mission_id]);
          })();
          out(row);
        } catch (e) { spool("mission-stage", { repo, handoff: s, error: String(e) }); }
      } else if (sub === "close") {
        try {
          const db = openDb();
          const p = projectFor(db, repo)!;
          const { mrow, absDir } = missionByDir(db, p, argv.dir, sub);
          if (mrow.status === "stopped") die(`mission ${mrow.id} is stopped; close only running/closed missions`);
          const files = readdirSync(absDir).filter(f => f.endsWith(".md")).sort();
          if (!files.length) die(`no *.md artifacts in ${absDir}`);
          db.transaction(() => {
            // Re-ingest after a crash replaces, never duplicates.
            ingestArtifacts(db, mrow.id, absDir, files);
            db.run("UPDATE missions SET status = 'closed', updated_at = datetime('now') WHERE id = ?", [mrow.id]);
          })();
          console.error(`ingested — the DB write succeeded; delete ${absDir} yourself now`);
          out({ ok: true, mission_id: mrow.id, ingested: files });
        } catch (e) { spool("mission-close", { repo, dir: argv.dir, error: String(e) }); }
      } else if (sub === "ingest") {
        // Mid-mission ingestion: the artifact survives even if the dir dies
        // before close. Close re-ingests everything idempotently anyway.
        try {
          const db = openDb();
          const p = projectFor(db, repo)!;
          const { mrow, absDir } = missionByDir(db, p, argv.dir, sub);
          if (mrow.status !== "running") die(`mission ${mrow.id} is ${mrow.status}; ingest only running missions`);
          // A bare --file must fail loudly, never silently ingest the whole dir.
          if (argv.file !== undefined && typeof argv.file !== "string") die("--file requires a filename");
          const only = argv.file ?? null;
          const files = readdirSync(absDir).filter(f => f.endsWith(".md") && (!only || f === only)).sort();
          if (!files.length) die(only ? `no artifact ${only} in ${absDir}` : `no *.md artifacts in ${absDir}`);
          db.transaction(() => { ingestArtifacts(db, mrow.id, absDir, files); })();
          out({ ok: true, mission_id: mrow.id, ingested: files });
        } catch (e) { spool("mission-ingest", { repo, dir: argv.dir, file: argv.file ?? null, error: String(e) }); }
      } else if (sub === "stop") {
        const id = intFlag(argv, "id");
        try {
          const db = openDb();
          const p = projectFor(db, repo)!;
          db.run(`UPDATE missions SET status = 'stopped', updated_at = datetime('now')
                  WHERE id = ? AND status = 'running'
                  AND task_id IN (SELECT id FROM tasks WHERE project_id = ?)`, [id, p.id]);
          if (!changes(db)) die(`no running mission ${id} in this project`);
          out(db.query("SELECT * FROM missions WHERE id = ?").get(id));
        } catch (e) { spool("mission-stop", { repo, id, error: String(e) }); }
      } else if (sub === "show") {
        const db = openDb();
        const p = readProject(db, repo);
        const mrow = argv.id !== undefined
          ? db.query(`SELECT m.* FROM missions m JOIN tasks t ON t.id = m.task_id
                      WHERE m.id = ? AND t.project_id = ?`).get(intFlag(argv, "id"), p.id) as any
          : activeMission(db, p.id);
        if (!mrow) { out(null); return; }
        const full = missionWithHandoffs(db, mrow);
        // --artifacts restores a lost mission dir from the DB (bodies included).
        if (argv.artifacts === true)
          full.artifacts = db.query(`SELECT id, filename, body, created_at
                                     FROM artifacts WHERE mission_id = ? ORDER BY filename`).all(mrow.id);
        out(full);
      } else die("mission open|stage|ingest|close|stop|show");
      return;
    }

    case "gate": {
      if (!repo) die("gate requires --repo <path>");
      if (sub === "get") {
        const db = openDb();
        const p = readProject(db, repo);
        out(db.query("SELECT ordinal, command, reason FROM gate_commands WHERE project_id = ? ORDER BY ordinal").all(p.id));
      } else if (sub === "set") {
        const rows = await stdinJson(); // [{command, reason}]
        try {
          const db = openDb();
          const p = projectFor(db, repo)!;
          db.transaction(() => {
            db.run("DELETE FROM gate_commands WHERE project_id = ?", [p.id]);
            rows.forEach((r: any, i: number) =>
              db.run("INSERT INTO gate_commands (project_id, ordinal, command, reason) VALUES (?,?,?,?)",
                [p.id, i + 1, r.command, r.reason ?? ""]));
          })();
          out({ ok: true, count: rows.length });
        } catch (e) { spool("gate-set", { repo, rows, error: String(e) }); }
      } else die("gate get|set");
      return;
    }

    case "prefs": {
      if (sub === "set") {
        const key = argv.key;
        if (typeof key !== "string" || !key) die("prefs set requires --key <name>");
        const body = (await Bun.stdin.text()).trim();
        try {
          const db = openDb();
          db.run("INSERT INTO prefs (key, body) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body = excluded.body", [key, body]);
          out({ ok: true, key });
        } catch (e) { spool("prefs-set", { key, body, error: String(e) }); }
      } else if (sub === "list") {
        const db = openDb();
        out(db.query("SELECT key, body FROM prefs ORDER BY key").all());
      } else die("prefs set|list");
      return;
    }

    case "knowledge": {
      if (!repo) die("knowledge requires --repo <path>");
      if (sub === "set") {
        const s = await stdinJson(); // {kind, title, body, paths_glob, verified_sha}
        try {
          const db = openDb();
          const p = projectFor(db, repo)!;
          db.run(`INSERT INTO knowledge_sections (project_id, kind, title, body, paths_glob, verified_sha, updated_at)
                  VALUES (?,?,?,?,?,?,datetime('now'))
                  ON CONFLICT(project_id, kind, title) DO UPDATE SET
                    body = excluded.body, paths_glob = excluded.paths_glob,
                    verified_sha = excluded.verified_sha, updated_at = datetime('now')`,
            [p.id, s.kind, s.title, s.body, s.paths_glob ?? "", s.verified_sha ?? null]);
          out({ ok: true });
        } catch (e) { spool("knowledge-set", { repo, section: s, error: String(e) }); }
      } else if (sub === "list") {
        const db = openDb();
        const p = readProject(db, repo);
        out(db.query("SELECT id, kind, title, body, paths_glob, verified_sha, updated_at FROM knowledge_sections WHERE project_id = ? ORDER BY kind, title").all(p.id));
      } else if (sub === "stale") {
        const db = openDb();
        const p = readProject(db, repo);
        const paths = String(argv.paths ?? "").split(",").map(x => x.trim()).filter(Boolean);
        const all = db.query("SELECT id, kind, title, paths_glob, verified_sha FROM knowledge_sections WHERE project_id = ?").all(p.id) as any[];
        out(all.filter(s =>
          (paths.length === 0 || globsCover(s.paths_glob, paths) || s.paths_glob === "") &&
          isStale(p.abs_path, s.verified_sha, s.paths_glob)));
      } else die("knowledge set|list|stale");
      return;
    }

    case "journal": {
      if (!repo) die("journal requires --repo <path>");
      if (sub !== "append") die("journal append");
      const entry = await stdinJson();
      // The spool must carry the patch CONTENT, not just its path — the temp
      // file the commander wrote it to may not survive the session.
      let patch: string | null = null;
      try {
        patch = argv["patch-file"] ? readFileSync(String(argv["patch-file"]), "utf8") : null;
        const db = openDb();
        const p = projectFor(db, repo)!;
        const itemTitle = entry.item_id
          ? ((db.query("SELECT title FROM items WHERE id = ?").get(entry.item_id) as any)?.title ?? "")
          : "";
        let row: any;
        db.transaction(() => {
          db.run(`INSERT INTO journal (project_id, task_id, item_id, entry_kind, gate_verdict,
                    decisions, questions, patch, head_sha, tree_hash)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [p.id, entry.task_id ?? null, entry.item_id ?? null, entry.entry_kind,
             entry.gate_verdict ?? null, entry.decisions ?? "", entry.questions ?? "",
             patch, entry.head_sha ?? null, entry.tree_hash ?? null]);
          row = db.query("SELECT * FROM journal WHERE id = last_insert_rowid()").get();
          db.run("INSERT INTO journal_fts (rowid, decisions, questions, item_title) VALUES (?,?,?,?)",
            [row.id, entry.decisions ?? "", entry.questions ?? "", itemTitle]);
          if (entry.entry_kind === "tick" && entry.task_id) {
            db.run("UPDATE tasks SET status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND status = 'approved'",
              [entry.task_id]);
          }
        })();
        out(row);
      } catch (e) {
        spool("journal-append", { repo, entry, patch, patch_file: argv["patch-file"] ?? null, error: String(e) });
      }
      return;
    }

    case "recall": {
      if (!repo) die("recall requires --repo <path>");
      const db = openDb();
      // Never auto-register on a read: an unknown repo routes to init instead
      // of silently becoming a half-initialized project.
      const p = projectFor(db, repo, false);
      if (!p) { out({ project: null }); return; }
      let task = activeTask(db, p.id);

      const lastWithHead = task
        ? db.query(`SELECT head_sha, tree_hash FROM journal
                    WHERE task_id = ? AND head_sha IS NOT NULL ORDER BY id DESC LIMIT 1`).get(task.id) as any
        : null;

      // review → committed flip when the human has committed (HEAD moved)
      if (task?.status === "review" && lastWithHead?.head_sha) {
        const head = sh(p.abs_path, ["git", "-C", p.abs_path, "rev-parse", "HEAD"]);
        if (head && head !== lastWithHead.head_sha) {
          db.run("UPDATE tasks SET status = 'committed', updated_at = datetime('now') WHERE id = ?", [task.id]);
          task = null;
        }
      }

      // Missions replaced items as the unit of work; the agent scopes knowledge
      // to the task itself when writing 00-intel.md.
      const missionRow = task
        ? db.query(`SELECT * FROM missions WHERE task_id = ? AND status = 'running'
                    ORDER BY id DESC LIMIT 1`).get(task.id) as any
        : null;
      const mission = missionRow ? missionWithHandoffs(db, missionRow) : null;

      const knowledge = db.query("SELECT id, kind, title, body, paths_glob, verified_sha FROM knowledge_sections WHERE project_id = ?").all(p.id) as any[];

      const tail = db.query(`SELECT id, task_id, item_id, entry_kind, gate_verdict, decisions,
                                    questions, head_sha, tree_hash, created_at
                             FROM journal WHERE project_id = ? ORDER BY id DESC LIMIT 5`).all(p.id) as any[];

      const openQuestions = task
        ? (db.query(`SELECT questions FROM journal WHERE task_id = ? AND questions != ''
                     ORDER BY id DESC LIMIT 5`).all(task.id) as any[]).map(r => r.questions)
        : [];

      // "Have we seen this before" — journal memory and past-mission artifacts,
      // both keyed off the task's own words.
      // Both queries scope to the project BEFORE the limit — a busy sibling
      // project must not be able to crowd this one's hits out of the cap.
      let ftsHits: any[] = [];
      let artifactHits: any[] = [];
      const q = task ? ftsQuery(`${task.title} ${task.description}`) : null;
      if (q) {
        const tailIds = new Set(tail.map(e => e.id));
        ftsHits = (db.query(`SELECT j.id, j.entry_kind, j.decisions, j.questions, j.created_at
                             FROM journal_fts f JOIN journal j ON j.id = f.rowid
                             WHERE journal_fts MATCH ? AND j.project_id = ?
                             ORDER BY j.id DESC LIMIT 15`).all(q, p.id) as any[])
          .filter(e => !tailIds.has(e.id)).slice(0, 5);
        artifactHits = db.query(`SELECT a.id, a.mission_id, m.slug, a.filename,
                                        substr(a.body, 1, 400) AS excerpt, a.created_at
                                 FROM artifacts_fts f
                                 JOIN artifacts a ON a.id = f.rowid
                                 JOIN missions m ON m.id = a.mission_id
                                 JOIN tasks t2 ON t2.id = m.task_id
                                 WHERE artifacts_fts MATCH ? AND t2.project_id = ?
                                 ORDER BY a.id DESC LIMIT 5`).all(q, p.id) as any[];
      }

      const refreshed = task
        ? db.query(`SELECT head_sha, tree_hash FROM journal
                    WHERE task_id = ? AND tree_hash IS NOT NULL ORDER BY id DESC LIMIT 1`).get(task.id) as any
        : null;

      out({
        project: p,
        prefs: db.query("SELECT key, body FROM prefs ORDER BY key").all(),
        task,
        mission,
        gate: db.query("SELECT ordinal, command, reason FROM gate_commands WHERE project_id = ? ORDER BY ordinal").all(p.id),
        knowledge,
        journal_tail: tail,
        open_questions: openQuestions,
        expected_tree_hash: refreshed?.tree_hash ?? null,
        expected_head_sha: refreshed?.head_sha ?? null,
        fts_hits: ftsHits,
        artifact_hits: artifactHits,
      });
      return;
    }

    case "status": {
      const db = openDb();
      const projects = db.query("SELECT * FROM projects ORDER BY name").all() as any[];
      out(projects.map(pr => {
        const m = activeMission(db, pr.id);
        return {
          project: { id: pr.id, name: pr.name, abs_path: pr.abs_path },
          active_task: activeTask(db, pr.id),
          active_mission: m ? { id: m.id, slug: m.slug, status: m.status,
            stage_plan: JSON.parse(m.stage_plan), stage_cursor: m.stage_cursor, updated_at: m.updated_at } : null,
          last_entry_at: (db.query("SELECT created_at FROM journal WHERE project_id = ? ORDER BY id DESC LIMIT 1").get(pr.id) as any)?.created_at ?? null,
        };
      }));
      return;
    }

    case "import": {
      if (!repo) die("import requires --repo <path>");
      const legacyDir = join(resolve(repo), ".anakin");
      if (!existsSync(legacyDir)) die(`no legacy directory at ${legacyDir}`);
      const read = (f: string) => existsSync(join(legacyDir, f)) ? readFileSync(join(legacyDir, f), "utf8") : "";
      try {
        const db = openDb();
        const p = projectFor(db, repo)!;
        const gate = parseGateMd(read("GATE.md"));
        const know = parseKnowledgeMd(read("KNOWLEDGE.md"));
        const roadmap = parseRoadmapMd(read("ROADMAP.md"));
        const entries = parseJournalMd(read("JOURNAL.md"));
        db.transaction(() => {
          db.run("DELETE FROM gate_commands WHERE project_id = ?", [p.id]);
          gate.forEach((g, i) =>
            db.run("INSERT INTO gate_commands (project_id, ordinal, command, reason) VALUES (?,?,?,?)",
              [p.id, i + 1, g.command, g.reason]));
          for (const s of know) {
            db.run(`INSERT INTO knowledge_sections (project_id, kind, title, body, paths_glob, verified_sha)
                    VALUES (?,?,?,?,?,?)
                    ON CONFLICT(project_id, kind, title) DO UPDATE SET
                      body = excluded.body, verified_sha = excluded.verified_sha, updated_at = datetime('now')`,
              [p.id, s.kind, s.title, s.body, "", s.verified_sha]);
          }
          if (roadmap.length && !activeTask(db, p.id)) {
            // A draft, not approved: the imported roadmap re-enters intake so
            // the human approves a mini-spec and stage plan before any mission.
            db.run("INSERT INTO tasks (project_id, title, description, mini_spec, status) VALUES (?,?,?,?,'draft')",
              [p.id, "Imported roadmap", "migrated from legacy .anakin/", ""]);
            const taskId = (db.query("SELECT last_insert_rowid() AS id").get() as any).id;
            roadmap.forEach((it, i) =>
              db.run(`INSERT INTO items (task_id, ordinal, title, files, done_when, contract, sensitive, status)
                      VALUES (?,?,?,?,?,?,?,?)`,
                [taskId, i + 1, it.title, it.files, it.done_when, it.contract, it.sensitive,
                 it.done ? "done" : "todo"]));
          }
          for (const e of entries) {
            db.run("INSERT INTO journal (project_id, entry_kind, decisions) VALUES (?, 'note', ?)",
              [p.id, `[imported] ${e.title}\n${e.body}`]);
            const jid = (db.query("SELECT last_insert_rowid() AS id").get() as any).id;
            db.run("INSERT INTO journal_fts (rowid, decisions, questions, item_title) VALUES (?,?,?,?)",
              [jid, `[imported] ${e.title}\n${e.body}`, "", ""]);
          }
        })();
        console.error(`import complete — review the DB, then delete ${legacyDir} yourself`);
        out({ gate: gate.length, knowledge: know.length, items: roadmap.length, journal: entries.length });
      } catch (e) {
        spool("import", { repo, error: String(e) });
      }
      return;
    }

    default:
      die(`unknown command: ${cmd ?? "(none)"}`);
  }
}

await main();
