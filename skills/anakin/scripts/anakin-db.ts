#!/usr/bin/env bun
// anakin-db — the only read/write path to ANAKIN's global memory.
// I/O helper, not an enforcement engine. Zero npm dependencies.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
  return db;
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

function activeTask(db: Database, projectId: string): any | null {
  return db.query(`SELECT * FROM tasks WHERE project_id = ?
                   AND status IN ('approved','in_progress','review')
                   ORDER BY id DESC LIMIT 1`).get(projectId) ?? null;
}

function globToRe(glob: string): RegExp {
  const esc = glob.trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "[^/]*")
    .replace(//g, ".*");
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
      const db = openDb();
      const p = projectFor(db, repo)!;
      if (sub === "new") {
        if (activeTask(db, p.id)) die("an active task already exists; close or commit it first (one task at a time)");
        const t = await stdinJson();
        try {
          db.run("INSERT INTO tasks (project_id, title, description, mini_spec) VALUES (?,?,?,?)",
            [p.id, t.title ?? "(untitled)", t.description ?? "", t.mini_spec ?? ""]);
          out(db.query("SELECT * FROM tasks WHERE id = last_insert_rowid()").get());
        } catch (e) { spool("task-new", { project: p.id, task: t, error: String(e) }); }
      } else if (sub === "show") {
        const row = argv.id
          ? db.query("SELECT * FROM tasks WHERE id = ? AND project_id = ?").get(Number(argv.id), p.id)
          : activeTask(db, p.id);
        out(row ?? null);
      } else if (sub === "approve") {
        const id = Number(argv.id); if (!id) die("task approve requires --id");
        const head = sh(p.abs_path, ["git", "-C", p.abs_path, "rev-parse", "HEAD"]);
        try {
          db.run("UPDATE tasks SET status = 'approved', baseline_sha = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ?",
            [head, id, p.id]);
          out(db.query("SELECT * FROM tasks WHERE id = ?").get(id));
        } catch (e) { spool("task-approve", { id, error: String(e) }); }
      } else if (sub === "close") {
        const id = Number(argv.id); if (!id) die("task close requires --id");
        try {
          db.run("UPDATE tasks SET status = 'review', updated_at = datetime('now') WHERE id = ? AND project_id = ?", [id, p.id]);
          out(db.query("SELECT * FROM tasks WHERE id = ?").get(id));
        } catch (e) { spool("task-close", { id, error: String(e) }); }
      } else if (sub === "status") {
        out({ project: p, active: activeTask(db, p.id) });
      } else die("task new|show|approve|close|status");
      return;
    }

    case "item": {
      if (!repo) die("item requires --repo <path>");
      const db = openDb();
      const p = projectFor(db, repo)!;
      if (sub === "add") {
        const taskId = Number(argv.task); if (!taskId) die("item add requires --task <id>");
        const it = await stdinJson();
        try {
          db.run(`INSERT INTO items (task_id, ordinal, title, files, done_when, contract, sensitive)
                  VALUES (?,?,?,?,?,?,?)`,
            [taskId, it.ordinal, it.title, it.files ?? "", it.done_when ?? "", it.contract ?? null, it.sensitive ?? null]);
          out(db.query("SELECT * FROM items WHERE id = last_insert_rowid()").get());
        } catch (e) { spool("item-add", { taskId, item: it, error: String(e) }); }
      } else if (sub === "list") {
        const taskId = Number(argv.task); if (!taskId) die("item list requires --task <id>");
        out(db.query("SELECT * FROM items WHERE task_id = ? ORDER BY ordinal").all(taskId));
      } else if (sub === "check") {
        const id = Number(argv.id); if (!id) die("item check requires --id");
        try {
          db.run("UPDATE items SET status = 'done', journal_id = ? WHERE id = ?",
            [argv.journal ? Number(argv.journal) : null, id]);
          out(db.query("SELECT * FROM items WHERE id = ?").get(id));
        } catch (e) { spool("item-check", { id, error: String(e) }); }
      } else die("item add|list|check");
      return;
    }

    case "gate": {
      if (!repo) die("gate requires --repo <path>");
      const db = openDb();
      const p = projectFor(db, repo)!;
      if (sub === "get") {
        out(db.query("SELECT ordinal, command, reason FROM gate_commands WHERE project_id = ? ORDER BY ordinal").all(p.id));
      } else if (sub === "set") {
        const rows = await stdinJson(); // [{command, reason}]
        try {
          db.transaction(() => {
            db.run("DELETE FROM gate_commands WHERE project_id = ?", [p.id]);
            rows.forEach((r: any, i: number) =>
              db.run("INSERT INTO gate_commands (project_id, ordinal, command, reason) VALUES (?,?,?,?)",
                [p.id, i + 1, r.command, r.reason ?? ""]));
          })();
          out({ ok: true, count: rows.length });
        } catch (e) { spool("gate-set", { project: p.id, rows, error: String(e) }); }
      } else die("gate get|set");
      return;
    }

    case "prefs": {
      const db = openDb();
      if (sub === "set") {
        const key = argv.key as string; if (!key) die("prefs set requires --key");
        const body = (await Bun.stdin.text()).trim();
        try {
          db.run("INSERT INTO prefs (key, body) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body = excluded.body", [key, body]);
          out({ ok: true, key });
        } catch (e) { spool("prefs-set", { key, body, error: String(e) }); }
      } else if (sub === "list") {
        out(db.query("SELECT key, body FROM prefs ORDER BY key").all());
      } else die("prefs set|list");
      return;
    }

    case "knowledge": {
      if (!repo) die("knowledge requires --repo <path>");
      const db = openDb();
      const p = projectFor(db, repo)!;
      if (sub === "set") {
        const s = await stdinJson(); // {kind, title, body, paths_glob, verified_sha}
        try {
          db.run(`INSERT INTO knowledge_sections (project_id, kind, title, body, paths_glob, verified_sha, updated_at)
                  VALUES (?,?,?,?,?,?,datetime('now'))
                  ON CONFLICT(project_id, kind, title) DO UPDATE SET
                    body = excluded.body, paths_glob = excluded.paths_glob,
                    verified_sha = excluded.verified_sha, updated_at = datetime('now')`,
            [p.id, s.kind, s.title, s.body, s.paths_glob ?? "", s.verified_sha ?? null]);
          out({ ok: true });
        } catch (e) { spool("knowledge-set", { project: p.id, section: s, error: String(e) }); }
      } else if (sub === "list") {
        out(db.query("SELECT id, kind, title, body, paths_glob, verified_sha, updated_at FROM knowledge_sections WHERE project_id = ? ORDER BY kind, title").all(p.id));
      } else if (sub === "stale") {
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
      const patch = argv["patch-file"] ? readFileSync(String(argv["patch-file"]), "utf8") : null;
      try {
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
        spool("journal-append", { repo, entry, patch, error: String(e) });
      }
      return;
    }

    case "recall": {
      if (!repo) die("recall requires --repo <path>");
      const db = openDb();
      const p = projectFor(db, repo)!;
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

      const items = task
        ? db.query("SELECT * FROM items WHERE task_id = ? ORDER BY ordinal").all(task.id) as any[]
        : [];
      const nextItem = items.find(i => i.status === "todo") ?? null;
      const itemFiles = nextItem
        ? String(nextItem.files).split(",").map((f: string) => f.trim()).filter(Boolean)
        : [];

      const allKnowledge = db.query("SELECT id, kind, title, body, paths_glob, verified_sha FROM knowledge_sections WHERE project_id = ?").all(p.id) as any[];
      const knowledge = nextItem
        ? allKnowledge.filter(k =>
            k.kind === "boundary" || k.kind === "sensitive_zone" || globsCover(k.paths_glob, itemFiles))
        : allKnowledge;

      const tail = db.query(`SELECT id, task_id, item_id, entry_kind, gate_verdict, decisions,
                                    questions, head_sha, tree_hash, created_at
                             FROM journal WHERE project_id = ? ORDER BY id DESC LIMIT 5`).all(p.id) as any[];

      const openQuestions = task
        ? (db.query(`SELECT questions FROM journal WHERE task_id = ? AND questions != ''
                     ORDER BY id DESC LIMIT 5`).all(task.id) as any[]).map(r => r.questions)
        : [];

      let ftsHits: any[] = [];
      if (nextItem) {
        const tokens = String(nextItem.title + " " + nextItem.done_when)
          .replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2);
        if (tokens.length) {
          const q = tokens.map(t2 => `"${t2}"`).join(" OR ");
          const tailIds = new Set(tail.map(e => e.id));
          const rowids = (db.query("SELECT rowid FROM journal_fts WHERE journal_fts MATCH ? LIMIT 10").all(q) as any[])
            .map(r => r.rowid).filter(id => !tailIds.has(id)).slice(0, 5);
          if (rowids.length) {
            ftsHits = db.query(`SELECT id, entry_kind, decisions, questions, created_at FROM journal
                                WHERE id IN (${rowids.map(() => "?").join(",")}) AND project_id = ?`)
              .all(...rowids, p.id) as any[];
          }
        }
      }

      const refreshed = task
        ? db.query(`SELECT head_sha, tree_hash FROM journal
                    WHERE task_id = ? AND tree_hash IS NOT NULL ORDER BY id DESC LIMIT 1`).get(task.id) as any
        : null;

      out({
        project: p,
        prefs: db.query("SELECT key, body FROM prefs ORDER BY key").all(),
        task,
        next_item: nextItem,
        items_remaining: items.filter(i => i.status === "todo").length,
        gate: db.query("SELECT ordinal, command, reason FROM gate_commands WHERE project_id = ? ORDER BY ordinal").all(p.id),
        knowledge,
        journal_tail: tail,
        open_questions: openQuestions,
        expected_tree_hash: refreshed?.tree_hash ?? null,
        expected_head_sha: refreshed?.head_sha ?? null,
        fts_hits: ftsHits,
      });
      return;
    }

    case "status": {
      const db = openDb();
      const projects = db.query("SELECT * FROM projects ORDER BY name").all() as any[];
      out(projects.map(pr => ({
        project: { id: pr.id, name: pr.name, abs_path: pr.abs_path },
        active_task: activeTask(db, pr.id),
        last_entry_at: (db.query("SELECT created_at FROM journal WHERE project_id = ? ORDER BY id DESC LIMIT 1").get(pr.id) as any)?.created_at ?? null,
      })));
      return;
    }

    default:
      die(`unknown command: ${cmd ?? "(none)"}`);
  }
}

await main();
