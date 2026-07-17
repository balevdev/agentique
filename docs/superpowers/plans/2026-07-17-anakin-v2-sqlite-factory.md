# ANAKIN v2 — Global SQLite Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all ANAKIN factory memory into a global `~/.anakin/anakin.db` SQLite database accessed through a zero-dependency bun CLI, make the factory commitless (patches journaled, human commits), and reshape the skill around one-task-at-a-time professional work.

**Architecture:** A single bun script (`scripts/anakin-db.ts`, `bun:sqlite`, zero npm deps) is the only read/write path to memory. The skill markdown is rewritten so phases route by DB state instead of disk state, `conceive.md` + `decompose.md` merge into `task.md`, and every tick rehydrates via one `recall` call. The target repo never gains a file or a commit from the factory.

**Tech Stack:** bun (runtime + `bun:sqlite` + `bun test`), SQLite (WAL, FTS5), git CLI, markdown skill files.

**Spec:** `docs/superpowers/specs/2026-07-17-anakin-v2-sqlite-factory-design.md` (approved 2026-07-17).

## Global Constraints

- Zero npm dependencies in `skills/anakin/scripts/` — `bun:sqlite` and `node:` builtins only.
- All prose reaches the CLI via stdin or `--patch-file`, never shell-quoted arguments.
- `ANAKIN_HOME` env var overrides `~/.anakin` (tests depend on this; default is `join(HOME, ".anakin")`).
- DB pragmas: `journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON`.
- Task status values, exactly: `draft → approved → in_progress → review → committed`.
- Knowledge kinds, exactly: `layout | boundary | convention | sensitive_zone | gotcha`.
- Journal entry kinds, exactly: `tick | approval | stop | note`.
- One active task per project (active = status IN `approved,in_progress,review`); `task new` must refuse a second.
- On any DB write failure the CLI writes the payload to `$ANAKIN_HOME/spool/` and exits non-zero printing the spool path.
- The factory never runs `git commit`, `git add`, or creates files inside the target repo. Skill markdown must not mention committed state files anywhere.
- Skill structure stays strict 2 levels: `SKILL.md`, `commands/anakin.md`, `references/*.md`, `scripts/*`.
- Vader is untouched.
- All CLI output is JSON on stdout (arrays/objects), errors as text on stderr.

## File Structure

```
skills/anakin/
  SKILL.md                      # REWRITE — DB memory, phase routing by DB state, never-commit
  commands/anakin.md            # REWRITE — routes via `recall`, new args (task/import)
  references/
    task.md                     # NEW — merged intake: light for tickets, full interview for greenfield + v1 decompose rules verbatim
    knowledge.md                # REWRITE — knowledge_sections rows + gate_commands instead of files
    tick.md                     # REWRITE — the 9-step commitless tick
    conceive.md                 # DELETE (merged into task.md)
    decompose.md                # DELETE (merged into task.md)
  scripts/
    package.json                # NEW — private, module, no deps
    schema.sql                  # NEW — all tables + FTS5
    anakin-db.ts                # NEW — the CLI (single file)
    anakin-db.test.ts           # NEW — bun test suite
README.md                       # small edit: anakin section reflects v2
docs/anakin-dogfood-2.md        # NEW — rehearsal run record (Task 10)
```

---

### Task 1: Scripts scaffold, schema, project identity (`init`)

**Files:**
- Create: `skills/anakin/scripts/package.json`
- Create: `skills/anakin/scripts/schema.sql`
- Create: `skills/anakin/scripts/anakin-db.ts`
- Test: `skills/anakin/scripts/anakin-db.test.ts`

**Interfaces:**
- Produces: CLI entry `bun anakin-db.ts <cmd> [flags]`; helpers `openDb(): Database`, `projectFor(db, repo, createIfMissing?)` returning a `projects` row; `sh(cwd, cmd: string[]): string | null`; `hash16(s: string): string`; `flags(argv): {_: string[], [k: string]: string|boolean}`; `stdinJson(): Promise<any>`; `out(x: unknown)` printing JSON. Subcommand `init --repo <path>` prints the project row.
- Consumes: nothing.

- [ ] **Step 1: Create package.json and schema.sql**

`skills/anakin/scripts/package.json`:

```json
{
  "name": "anakin-scripts",
  "private": true,
  "type": "module"
}
```

`skills/anakin/scripts/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  origin_url TEXT,
  abs_path   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  mini_spec    TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','approved','in_progress','review','committed')),
  baseline_sha TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  ordinal    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  files      TEXT NOT NULL DEFAULT '',
  done_when  TEXT NOT NULL DEFAULT '',
  contract   TEXT,
  sensitive  TEXT,
  status     TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done')),
  journal_id INTEGER REFERENCES journal(id)
);

CREATE TABLE IF NOT EXISTS knowledge_sections (
  id           INTEGER PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  kind         TEXT NOT NULL
               CHECK (kind IN ('layout','boundary','convention','sensitive_zone','gotcha')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  paths_glob   TEXT NOT NULL DEFAULT '',
  verified_sha TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, kind, title)
);

CREATE TABLE IF NOT EXISTS journal (
  id           INTEGER PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  task_id      INTEGER REFERENCES tasks(id),
  item_id      INTEGER REFERENCES items(id),
  entry_kind   TEXT NOT NULL CHECK (entry_kind IN ('tick','approval','stop','note')),
  gate_verdict TEXT,
  decisions    TEXT NOT NULL DEFAULT '',
  questions    TEXT NOT NULL DEFAULT '',
  patch        TEXT,
  head_sha     TEXT,
  tree_hash    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(
  decisions, questions, item_title, content=''
);

CREATE TABLE IF NOT EXISTS gate_commands (
  project_id TEXT NOT NULL REFERENCES projects(id),
  ordinal    INTEGER NOT NULL,
  command    TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, ordinal)
);

CREATE TABLE IF NOT EXISTS prefs (
  key  TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
```

- [ ] **Step 2: Write the failing test**

`skills/anakin/scripts/anakin-db.test.ts`:

```ts
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "anakin-db.ts");
let home: string;

function run(args: string[], stdin?: string) {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    env: { ...process.env, ANAKIN_HOME: home },
    stdin: stdin !== undefined ? Buffer.from(stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
    json: () => JSON.parse(p.stdout.toString()),
  };
}

function makeRepo(origin?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "anakin-repo-"));
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, ...a]);
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  if (origin) git("remote", "add", "origin", origin);
  return dir;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "anakin-home-"));
});

describe("init / project identity", () => {
  test("registers a project keyed by normalized origin URL", () => {
    const repo = makeRepo("git@github.com:acme/widget.git");
    const r = run(["init", "--repo", repo]);
    expect(r.code).toBe(0);
    const p = r.json();
    expect(p.origin_url).toBe("github.com/acme/widget");
    expect(p.abs_path).toBe(repo);
    expect(p.id).toHaveLength(16);
  });

  test("same origin at a different path is the same project (moved repo)", () => {
    const a = makeRepo("https://github.com/acme/widget.git");
    const b = makeRepo("git@github.com:acme/widget.git");
    const ida = run(["init", "--repo", a]).json().id;
    const rb = run(["init", "--repo", b]).json();
    expect(rb.id).toBe(ida);
    expect(rb.abs_path).toBe(b); // abs_path updated to the new location
  });

  test("repo without origin falls back to path hash", () => {
    const repo = makeRepo();
    const p = run(["init", "--repo", repo]).json();
    expect(p.origin_url).toBeNull();
    expect(p.id).toHaveLength(16);
    // second init at same path is idempotent
    expect(run(["init", "--repo", repo]).json().id).toBe(p.id);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd skills/anakin/scripts && bun test anakin-db.test.ts`
Expected: FAIL (CLI file does not exist / exit code non-zero).

- [ ] **Step 4: Write the CLI skeleton with init**

`skills/anakin/scripts/anakin-db.ts`:

```ts
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
    default:
      die(`unknown command: ${cmd ?? "(none)"}`);
  }
}

await main();
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd skills/anakin/scripts && bun test anakin-db.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add skills/anakin/scripts/
git commit -m "feat(anakin): v2 scripts scaffold — schema, project identity, init"
```

---

### Task 2: `gate`, `prefs`, `knowledge` subcommands

**Files:**
- Modify: `skills/anakin/scripts/anakin-db.ts`
- Test: `skills/anakin/scripts/anakin-db.test.ts`

**Interfaces:**
- Consumes: `openDb`, `projectFor`, `sh`, `stdinJson`, `out`, `die`, `spool` from Task 1.
- Produces: `gate set` (stdin: `[{command, reason}]`, replaces all rows) / `gate get`; `prefs set --key <k>` (stdin: body text) / `prefs list`; `knowledge set` (stdin: `{kind, title, body, paths_glob, verified_sha}`, upsert by kind+title) / `knowledge list` / `knowledge stale --paths <csv>`; helpers `globToRe(glob): RegExp`, `globsCover(globsCsv, paths: string[]): boolean`, `isStale(repo, verified_sha, paths_glob): boolean`. Later tasks (recall) rely on `globsCover` and these tables.

- [ ] **Step 1: Write the failing tests** (append to `anakin-db.test.ts`)

```ts
describe("gate / prefs / knowledge", () => {
  test("gate set replaces, gate get returns in order", () => {
    const repo = makeRepo();
    run(["init", "--repo", repo]);
    run(["gate", "set", "--repo", repo],
      JSON.stringify([{ command: "bun test", reason: "unit tests" },
                      { command: "bunx tsc --noEmit", reason: "types" }]));
    let g = run(["gate", "get", "--repo", repo]).json();
    expect(g.map((r: any) => r.command)).toEqual(["bun test", "bunx tsc --noEmit"]);
    run(["gate", "set", "--repo", repo], JSON.stringify([{ command: "make check", reason: "" }]));
    g = run(["gate", "get", "--repo", repo]).json();
    expect(g).toHaveLength(1);
  });

  test("prefs are global and listable", () => {
    run(["prefs", "set", "--key", "deps"], "stdlib before dependency; new deps need a one-line justification");
    const p = run(["prefs", "list"]).json();
    expect(p).toEqual([{ key: "deps", body: "stdlib before dependency; new deps need a one-line justification" }]);
  });

  test("knowledge set upserts by kind+title; stale detects commits under the glob", () => {
    const repo = makeRepo();
    run(["init", "--repo", repo]);
    const sha = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
    run(["knowledge", "set", "--repo", repo],
      JSON.stringify({ kind: "layout", title: "root", body: "single module", paths_glob: "*.txt", verified_sha: sha }));
    run(["knowledge", "set", "--repo", repo],
      JSON.stringify({ kind: "layout", title: "root", body: "UPDATED", paths_glob: "*.txt", verified_sha: sha }));
    const list = run(["knowledge", "list", "--repo", repo]).json();
    expect(list).toHaveLength(1);
    expect(list[0].body).toBe("UPDATED");

    // nothing stale yet
    expect(run(["knowledge", "stale", "--repo", repo, "--paths", "a.txt"]).json()).toHaveLength(0);

    // a commit touching the glob makes it stale
    writeFileSync(join(repo, "a.txt"), "changed\n");
    Bun.spawnSync(["git", "-C", repo, "commit", "-aqm", "touch a"]);
    const stale = run(["knowledge", "stale", "--repo", repo, "--paths", "a.txt"]).json();
    expect(stale.map((s: any) => s.title)).toEqual(["root"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test anakin-db.test.ts`
Expected: new tests FAIL with "unknown command: gate" etc.

- [ ] **Step 3: Implement** (add helpers after `projectFor`, cases in the `switch`)

```ts
function globToRe(glob: string): RegExp {
  const esc = glob.trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
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
```

Switch cases (inside `main`, each write wrapped so failures spool):

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test anakin-db.test.ts` — Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add skills/anakin/scripts/
git commit -m "feat(anakin): gate, prefs, knowledge subcommands with scoped staleness"
```

---

### Task 3: Task and item lifecycle

**Files:**
- Modify: `skills/anakin/scripts/anakin-db.ts`
- Test: `skills/anakin/scripts/anakin-db.test.ts`

**Interfaces:**
- Consumes: Task 1–2 helpers.
- Produces: `task new` (stdin: `{title, description, mini_spec}`) → prints task row; `task show [--id]`; `task approve --id` (sets `approved`, `baseline_sha` = current HEAD); `task close --id` (sets `review`); `task status`; `item add --task <id>` (stdin: `{ordinal, title, files, done_when, contract?, sensitive?}`); `item list --task <id>`; `item check --id <itemId> --journal <journalId>`. Helper `activeTask(db, projectId)` → latest task with status IN ('approved','in_progress','review') or null. Recall (Task 5) relies on `activeTask` and `baseline_sha`.

- [ ] **Step 1: Write the failing tests** (append)

```ts
describe("task / item lifecycle", () => {
  test("draft → approved (baseline recorded) → close → review; one active task enforced", () => {
    const repo = makeRepo();
    run(["init", "--repo", repo]);
    const t = run(["task", "new", "--repo", repo],
      JSON.stringify({ title: "Add greeting", description: "ticket text", mini_spec: "purpose..." })).json();
    expect(t.status).toBe("draft");

    run(["task", "approve", "--repo", repo, "--id", String(t.id)]);
    const shown = run(["task", "show", "--repo", repo]).json();
    expect(shown.status).toBe("approved");
    expect(shown.baseline_sha).toHaveLength(40);

    // second active task refused
    const dup = run(["task", "new", "--repo", repo], JSON.stringify({ title: "Another" }));
    expect(dup.code).not.toBe(0);

    run(["task", "close", "--repo", repo, "--id", String(t.id)]);
    expect(run(["task", "show", "--repo", repo, "--id", String(t.id)]).json().status).toBe("review");
  });

  test("items: add in order, check marks done and links journal id", () => {
    const repo = makeRepo();
    run(["init", "--repo", repo]);
    const t = run(["task", "new", "--repo", repo], JSON.stringify({ title: "T" })).json();
    run(["task", "approve", "--repo", repo, "--id", String(t.id)]);
    const i1 = run(["item", "add", "--repo", repo, "--task", String(t.id)],
      JSON.stringify({ ordinal: 1, title: "define contract", files: "src/api.ts", done_when: "type exported", contract: "type Greeting = {msg: string}" })).json();
    run(["item", "add", "--repo", repo, "--task", String(t.id)],
      JSON.stringify({ ordinal: 2, title: "use contract", files: "src/app.ts", done_when: "renders msg", sensitive: "public-api" }));
    const list = run(["item", "list", "--repo", repo, "--task", String(t.id)]).json();
    expect(list.map((i: any) => i.ordinal)).toEqual([1, 2]);

    run(["item", "check", "--repo", repo, "--id", String(i1.id), "--journal", "99"]);
    const after = run(["item", "list", "--repo", repo, "--task", String(t.id)]).json();
    expect(after[0].status).toBe("done");
    expect(after[0].journal_id).toBe(99);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `bun test anakin-db.test.ts`, new tests FAIL ("unknown command: task").

- [ ] **Step 3: Implement** (helper + switch cases)

```ts
function activeTask(db: Database, projectId: string): any | null {
  return db.query(`SELECT * FROM tasks WHERE project_id = ?
                   AND status IN ('approved','in_progress','review')
                   ORDER BY id DESC LIMIT 1`).get(projectId) ?? null;
}
```

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass** — `bun test anakin-db.test.ts`, PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/anakin/scripts/
git commit -m "feat(anakin): task and item lifecycle with single-active-task rule"
```

---

### Task 4: `journal append` — FTS index and spool fallback

**Files:**
- Modify: `skills/anakin/scripts/anakin-db.ts`
- Test: `skills/anakin/scripts/anakin-db.test.ts`

**Interfaces:**
- Consumes: Task 1–3 helpers and tables.
- Produces: `journal append --repo <path> [--patch-file <p>]`, stdin JSON `{task_id?, item_id?, entry_kind, gate_verdict?, decisions?, questions?, head_sha?, tree_hash?}` → prints the inserted row id; on any failure (including DB open failure) the payload lands in `$ANAKIN_HOME/spool/` and exit code is 1. Every insert also populates `journal_fts` (rowid = journal id, `item_title` looked up from `items`). Recall (Task 5) queries `journal_fts` by rowid.

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { chmodSync, rmSync, readdirSync as rd } from "node:fs";

describe("journal", () => {
  test("append stores entry + patch and indexes FTS", () => {
    const repo = makeRepo();
    run(["init", "--repo", repo]);
    const t = run(["task", "new", "--repo", repo], JSON.stringify({ title: "T" })).json();
    run(["task", "approve", "--repo", repo, "--id", String(t.id)]);
    const it = run(["item", "add", "--repo", repo, "--task", String(t.id)],
      JSON.stringify({ ordinal: 1, title: "wire the flux capacitor", files: "src/flux.ts", done_when: "green" })).json();

    const patchFile = join(home, "p.diff");
    writeFileSync(patchFile, "diff --git a/src/flux.ts b/src/flux.ts\n+capacitor\n");
    const r = run(["journal", "append", "--repo", repo, "--patch-file", patchFile],
      JSON.stringify({ task_id: t.id, item_id: it.id, entry_kind: "tick", gate_verdict: "green",
        decisions: "used polling because webhooks flaked", questions: "", head_sha: "a".repeat(40), tree_hash: "h1" }));
    expect(r.code).toBe(0);
    const entry = r.json();
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.patch).toContain("capacitor");
  });

  test("write failure spools the payload and exits non-zero", () => {
    const repo = makeRepo();
    run(["init", "--repo", repo]);
    // make the DB unopenable for writes; spool dir stays writable
    rmSync(join(home, "anakin.db-wal"), { force: true });
    rmSync(join(home, "anakin.db-shm"), { force: true });
    chmodSync(join(home, "anakin.db"), 0o444);
    const r = run(["journal", "append", "--repo", repo],
      JSON.stringify({ entry_kind: "note", decisions: "must not be lost" }));
    chmodSync(join(home, "anakin.db"), 0o644);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("spooled");
    const spooled = rd(join(home, "spool"));
    expect(spooled.length).toBe(1);
    const payload = JSON.parse(String(Bun.file ? require("node:fs").readFileSync(join(home, "spool", spooled[0]), "utf8") : ""));
    expect(JSON.stringify(payload)).toContain("must not be lost");
  });
});
```

(Use plain `readFileSync` from the existing import for the payload read — adjust the last two lines to `const payload = JSON.parse(readFileSync(join(home, "spool", spooled[0]), "utf8"));` with `readFileSync` added to the test file's imports.)

- [ ] **Step 2: Run tests to verify they fail** — new tests FAIL ("unknown command: journal").

- [ ] **Step 3: Implement** (switch case; note the openDb inside try)

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass** — `bun test anakin-db.test.ts`, PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/anakin/scripts/
git commit -m "feat(anakin): journal append with FTS indexing and spool fallback"
```

---

### Task 5: `recall` — the one-call rehydration packet + review→committed flip + `status`

**Files:**
- Modify: `skills/anakin/scripts/anakin-db.ts`
- Test: `skills/anakin/scripts/anakin-db.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4 (`activeTask`, `globsCover`, `journal_fts`).
- Produces: `recall --repo <path>` printing:

```json
{
  "project": {},
  "prefs": [],
  "task": null,
  "next_item": null,
  "items_remaining": 0,
  "gate": [],
  "knowledge": [],
  "journal_tail": [],
  "open_questions": [],
  "expected_tree_hash": null,
  "expected_head_sha": null,
  "fts_hits": []
}
```

  Also `status` (no `--repo`): cross-project overview `[{project, active_task, last_entry_at}]`. Side effect: a `review` task whose last recorded `head_sha` differs from current HEAD flips to `committed` during recall.

- [ ] **Step 1: Write the failing tests** (append)

```ts
describe("recall", () => {
  function seed(repo: string) {
    run(["init", "--repo", repo]);
    const sha = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
    run(["prefs", "set", "--key", "style"], "boring code wins");
    run(["gate", "set", "--repo", repo], JSON.stringify([{ command: "bun test", reason: "" }]));
    run(["knowledge", "set", "--repo", repo],
      JSON.stringify({ kind: "convention", title: "naming", body: "snake files", paths_glob: "src/**", verified_sha: sha }));
    run(["knowledge", "set", "--repo", repo],
      JSON.stringify({ kind: "boundary", title: "no-infra-in-domain", body: "domain never imports infra", paths_glob: "other/**", verified_sha: sha }));
    run(["knowledge", "set", "--repo", repo],
      JSON.stringify({ kind: "gotcha", title: "unrelated", body: "docs quirk", paths_glob: "docs/**", verified_sha: sha }));
    const t = run(["task", "new", "--repo", repo], JSON.stringify({ title: "T" })).json();
    run(["task", "approve", "--repo", repo, "--id", String(t.id)]);
    const it = run(["item", "add", "--repo", repo, "--task", String(t.id)],
      JSON.stringify({ ordinal: 1, title: "flux capacitor wiring", files: "src/flux.ts", done_when: "green" })).json();
    return { t, it, sha };
  }

  test("packet: task, next item, scoped knowledge (globs + all boundaries), prefs, FTS hits", () => {
    const repo = makeRepo();
    const { t, it } = seed(repo);
    // a past decision mentioning the same words, findable via FTS
    run(["journal", "append", "--repo", repo],
      JSON.stringify({ task_id: t.id, entry_kind: "note", decisions: "flux capacitor needs shielding" }));
    const r = run(["recall", "--repo", repo]).json();
    expect(r.task.id).toBe(t.id);
    expect(r.next_item.id).toBe(it.id);
    expect(r.gate).toHaveLength(1);
    const titles = r.knowledge.map((k: any) => k.title).sort();
    expect(titles).toEqual(["naming", "no-infra-in-domain"]); // glob match + boundary always; gotcha excluded
    expect(r.prefs[0].body).toBe("boring code wins");
    expect(r.fts_hits.length).toBeGreaterThan(0);
    expect(r.fts_hits[0].decisions).toContain("shielding");
  });

  test("open questions and expected tree hash come from the journal tail", () => {
    const repo = makeRepo();
    const { t, it } = seed(repo);
    run(["journal", "append", "--repo", repo],
      JSON.stringify({ task_id: t.id, item_id: it.id, entry_kind: "stop",
        questions: "which currency rounding?", tree_hash: "TH1", head_sha: "b".repeat(40) }));
    const r = run(["recall", "--repo", repo]).json();
    expect(r.open_questions).toEqual(["which currency rounding?"]);
    expect(r.expected_tree_hash).toBe("TH1");
  });

  test("human commit flips review task to committed, with no stale expectations", () => {
    const repo = makeRepo();
    const { t, it } = seed(repo);
    const head = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
    run(["journal", "append", "--repo", repo],
      JSON.stringify({ task_id: t.id, item_id: it.id, entry_kind: "tick", gate_verdict: "green", tree_hash: "TH", head_sha: head }));
    run(["task", "close", "--repo", repo, "--id", String(t.id)]);
    // human commits
    writeFileSync(join(repo, "b.txt"), "human work\n");
    Bun.spawnSync(["git", "-C", repo, "add", "-A"]);
    Bun.spawnSync(["git", "-C", repo, "commit", "-qm", "human: ship task"]);
    const r = run(["recall", "--repo", repo]).json();
    expect(r.task).toBeNull();
    expect(r.expected_tree_hash).toBeNull();
    const shown = run(["task", "show", "--repo", repo, "--id", String(t.id)]).json();
    expect(shown.status).toBe("committed");
  });
});

describe("status", () => {
  test("cross-project overview", () => {
    const a = makeRepo("git@github.com:acme/a.git");
    const b = makeRepo("git@github.com:acme/b.git");
    run(["init", "--repo", a]);
    run(["init", "--repo", b]);
    const s = run(["status"]).json();
    expect(s).toHaveLength(2);
    expect(s[0]).toHaveProperty("active_task");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — new tests FAIL ("unknown command: recall" / "status").

- [ ] **Step 3: Implement** (switch cases)

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass** — `bun test anakin-db.test.ts`, PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/anakin/scripts/
git commit -m "feat(anakin): one-call recall packet, committed-flip, cross-project status"
```

---

### Task 6: `import` — legacy `.anakin/` migration

**Files:**
- Modify: `skills/anakin/scripts/anakin-db.ts`
- Test: `skills/anakin/scripts/anakin-db.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `import --repo <path>` reading `<repo>/.anakin/{GATE.md, KNOWLEDGE.md, ROADMAP.md, JOURNAL.md}` (each optional) into `gate_commands`, `knowledge_sections`, one `approved` task titled "Imported roadmap" with items (checked → `done`), and `note` journal entries. Prints a summary `{gate, knowledge, items, journal}` counts and instructs the human (stderr) to delete the folder. Never deletes anything itself.

- [ ] **Step 1: Write the failing test** (append)

```ts
describe("import", () => {
  test("migrates a legacy .anakin directory into the DB", () => {
    const repo = makeRepo();
    const dir = join(repo, ".anakin");
    mkdirSync(dir);
    writeFileSync(join(dir, "GATE.md"),
      "# Gate\n\n- `bun test` — unit tests\n- `bunx tsc --noEmit` — types\n");
    writeFileSync(join(dir, "KNOWLEDGE.md"),
      "# Map\n\n## Layout\n\nsrc/ owns everything.\n\nverified: abc1234\n\n## Boundaries\n\ndomain never imports infra.\n\nverified: abc1234\n");
    writeFileSync(join(dir, "ROADMAP.md"),
      "# Roadmap\n\n- [x] 1. define contract\n      files: src/api.ts\n      done-when: type exported\n- [ ] 2. use contract\n      files: src/app.ts\n      done-when: renders msg\n      sensitive: public-api\n");
    writeFileSync(join(dir, "JOURNAL.md"),
      "# Journal\n\n## 2026-07-17 — tick 1: define contract\ngate: green\ndecisions: exported Greeting\n");

    const r = run(["import", "--repo", repo]);
    expect(r.code).toBe(0);
    const summary = r.json();
    expect(summary.gate).toBe(2);
    expect(summary.knowledge).toBe(2);
    expect(summary.items).toBe(2);
    expect(summary.journal).toBe(1);
    expect(r.err).toContain("delete");

    const g = run(["gate", "get", "--repo", repo]).json();
    expect(g[0].command).toBe("bun test");
    const k = run(["knowledge", "list", "--repo", repo]).json();
    expect(k.find((s: any) => s.kind === "boundary")).toBeTruthy();
    const t = run(["task", "show", "--repo", repo]).json();
    expect(t.title).toBe("Imported roadmap");
    const items = run(["item", "list", "--repo", repo, "--task", String(t.id)]).json();
    expect(items[0].status).toBe("done");
    expect(items[1].sensitive).toBe("public-api");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL ("unknown command: import").

- [ ] **Step 3: Implement** (parsers + switch case)

```ts
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
```

```ts
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
            const head = sh(p.abs_path, ["git", "-C", p.abs_path, "rev-parse", "HEAD"]);
            db.run("INSERT INTO tasks (project_id, title, description, mini_spec, status, baseline_sha) VALUES (?,?,?,?,'approved',?)",
              [p.id, "Imported roadmap", "migrated from legacy .anakin/", "", head]);
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
```

- [ ] **Step 4: Run tests to verify they pass** — `bun test anakin-db.test.ts`, PASS (full suite).

- [ ] **Step 5: Commit**

```bash
git add skills/anakin/scripts/
git commit -m "feat(anakin): legacy .anakin/ import into the global DB"
```

---

### Task 7: Rewrite `SKILL.md` and `commands/anakin.md`

**Files:**
- Modify: `skills/anakin/SKILL.md` (full rewrite)
- Modify: `skills/anakin/commands/anakin.md` (full rewrite)

**Interfaces:**
- Consumes: CLI surface from Tasks 1–6 (exact subcommand names).
- Produces: phase routing contract used by all references: init / intake / tick / close / waiting-review, decided from `recall` output.

No tests; verification is the token audit in Step 3 and the rehearsal in Task 10.

- [ ] **Step 1: Write `skills/anakin/SKILL.md`** (replace entire file)

```markdown
---
name: anakin
description: Run the ANAKIN software factory — turn everyday engineering tasks (tickets, features, hardening) into reviewed diffs through small autonomous ticks, with all memory in a global SQLite database and zero traces in the repo. Use when the user asks for an anakin run, says "anakin init" or "anakin task", wants a repo built or hardened autonomously via /loop, or wants hands-off task-after-task work where the factory never commits and the human reviews each finished task.
---

# ANAKIN — the minimal software factory

Turn one approved task into one reviewed diff through small, verified,
journaled ticks. One tick = one item = one verified diff. Between ticks the
context is discarded; the global database at `~/.anakin/anakin.db` is the only
memory. The target repo stays 100% clean: the factory creates no files in it
and makes no commits — ever. The human reviews and commits each finished task.

## Operating principles

When a situation is not covered below, decide by these, in this order:

1. **Context is finite.** A tick reads a bounded packet: this file, the
   reference for the current phase, and one `recall` call. Anything else you
   need, you go read from the repo when the work demands it.
2. **The repo belongs to the human.** No factory files inside it, no factory
   commits, no `git add`. Checkpoints are patches in the journal; the tree is
   the shared workbench and dirty is its normal state.
3. **Knowledge is obtained, not imposed.** ANAKIN learns the repo's real
   architecture into `knowledge_sections` rows and keeps them verified against
   commits. A boundary worth enforcing gets encoded in tools someone else
   maintains — a lint rule, a fallow boundary, a real test — proposed as a
   task item, never as a bespoke engine.
4. **Determinism beats discipline.** The only thing that blocks a tick is the
   repo's own toolchain, recorded in `gate_commands`. The gate runs before any
   LLM review; a red gate spawns zero reviewers. Gate rows are read-only
   during a tick — a gate you edited to pass proves nothing.
5. **The main context builds.** Subagents are read-only scouts for unmapped
   territory, plus at most one reviewer for sensitive diffs. No relay chains.
6. **Ask at intake, never mid-tick.** Questions are cheap during intake and
   poison mid-build. Mid-tick ambiguity is journaled and becomes a clean stop.

## Memory — the database and its CLI

All memory lives in `~/.anakin/anakin.db` (every project, one file). The only
read/write path is the CLI next to this skill:

    bun "<this skill's directory>/scripts/anakin-db.ts" <cmd> --repo .

Prose goes through stdin (JSON) or `--patch-file`, never shell-quoted args.
The subcommands: `init`, `recall` (the whole rehydration packet in one call),
`task new|show|approve|close|status`, `item add|list|check`,
`knowledge set|list|stale`, `gate get|set`, `prefs set|list`,
`journal append`, `import` (legacy `.anakin/` folders), `status`
(cross-project). If a write fails, the CLI spools the payload to
`~/.anakin/spool/` and exits non-zero — stop cleanly and tell the human.

## Phase routing — by DB state

Run `recall --repo .` once and route on its output:

- **Project unknown / no gate commands** → init. Read `references/knowledge.md`.
- **No active task** → intake. Read `references/task.md`. (A task submitted by
  the human via `/anakin task <text>` starts here.)
- **Active task with todo items** → tick. Read `references/tick.md`. Steady state.
- **Active task, all items done** → close: run the full gate once on the whole
  tree, write a reviewer-oriented summary of the combined diff (per-item map of
  what changed and why), `task close`, journal it, stop for human review.
- **Task in `review`** → the human hasn't committed yet. Stop with the same
  ask. (When they commit, the next recall flips the task to `committed`
  automatically.)

## Git behavior

Never commit. Never stage. Each tick ends by journaling the cumulative task
patch (`git diff <baseline_sha>`) plus `head_sha` and a hash of `git diff
HEAD`, so every checkpoint is recoverable from the DB alone. Human edits to
the tree mid-task are normal: reconcile them (see tick.md), never revert them.

## Human touchpoints and autonomy

Exactly two: approve the mini-spec + items at intake, and review/commit the
combined diff when the task closes. Between them ANAKIN runs tick after tick,
stopping itself only when: the task's items are exhausted (→ close), the gate
stays red after three distinct fix attempts, an ambiguity needs the human
(journaled first), human edits conflict with the current item, or the DB is
unreachable (spool written). A stop is always clean: journal written, tree
left as-is, final message states exactly what is needed to resume.

## Requirements

- A git repo (identity, baselines, and patches all come from git).
- `bun` (the CLI runs on it; no npm installs needed).
- `/loop` (or any recurring driver) for autonomy; a single `/anakin` firing
  runs one phase step and is useful on its own.
- Optional, used when present: `repomap` (knowledge acquisition, impact
  queries), `fallow` (structural gate step). Degrade gracefully when absent.

## What ANAKIN deliberately does not have

No constitution compiler, no fingerprint locks, no critic agents, no parallel
worktree owners, no voter panels, no autonomy ratchets, no per-harness
adapters, no state files in the repo, no task queue. Its predecessor (vader)
had the first seven; they cost ~20 subagent dispatches and ~13k instruction
tokens per tick and lost information at every handoff. ANAKIN keeps what
earned its place — deterministic gate first, rehydrate don't re-derive, one
item one diff, triaged stops — and deletes the rest.
```

- [ ] **Step 2: Write `skills/anakin/commands/anakin.md`** (replace entire file)

```markdown
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
```

- [ ] **Step 3: Token audit**

Run: `wc -c skills/anakin/SKILL.md skills/anakin/commands/anakin.md skills/anakin/references/tick.md`
Expected: combined under ~16,000 chars (≈4k tokens per-tick load). If over, trim prose, not rules.
(tick.md is rewritten in Task 8; run this audit again there.)

- [ ] **Step 4: Commit**

```bash
git add skills/anakin/SKILL.md skills/anakin/commands/anakin.md
git commit -m "feat(anakin): v2 SKILL and command — DB routing, commitless git behavior"
```

---

### Task 8: References — `task.md` (merged), `knowledge.md`, `tick.md`; delete old files

**Files:**
- Create: `skills/anakin/references/task.md`
- Modify: `skills/anakin/references/knowledge.md` (full rewrite)
- Modify: `skills/anakin/references/tick.md` (full rewrite)
- Delete: `skills/anakin/references/conceive.md`, `skills/anakin/references/decompose.md`

**Interfaces:**
- Consumes: CLI surface (exact subcommands) and phase contract from Task 7.
- Produces: the three phase references the command routes to.

- [ ] **Step 1: Write `skills/anakin/references/task.md`**

```markdown
# Intake: ask → mini-spec → items → approval

Goal: a task the human has actually approved — mini-spec plus one-tick items —
built from answers rather than assumptions. Questions are cheap here and
poison mid-build; this is the phase that absorbs them all.

## Scale the interview to the ask

Read the recall packet's knowledge sections first so questions come from
someone who knows the repo. Then:

- **A ticket or small ask** — most days. Ask ONLY on real ambiguity: a few
  questions, multiple-choice preferred, skip everything the ticket or the repo
  already answers. Often zero questions is correct.
- **A greenfield idea** — the fuller interview, one question at a time:
  purpose (what problem, for whom, what does done look like), scope and
  non-goals (the cheapest place to kill scope creep), constraints, sensitive
  contact (does this touch a sensitive_zone section? confirmed behavior there
  becomes acceptance), success criteria (observable checks, not adjectives).

Stop interviewing when a competent engineer could start.

## The mini-spec

Store via `task new` (stdin JSON: title, description = the raw ask,
mini_spec). The mini-spec, under half a page: purpose, behavior
(input → output, the interesting cases), non-goals (blunt bullets),
acceptance (numbered, each verifiable by the gate, by running the code, or by
reading the diff — "feels fast" is not acceptance).

## Items — one tick each

Add via `item add` (stdin JSON: ordinal, title, files, done_when, contract?,
sensitive?). An item is right-sized when ALL of these hold:

- **One concern.** One module or one behavior. If describing it needs "and", cut it.
- **One diff reviewable in ~5 minutes.** One endpoint, one component, one
  migration, one refactor of one file cluster.
- **Completable in one fresh context.** The implementer holds the item, its
  files, and the knowledge sections — nothing more.
- **Gate-checkable on its own.** After the item the gate is green and something
  new demonstrably works. No item may leave the tree red for the next one.

Ordering:

- **Contracts before consumers.** Shared interfaces are defined by the first
  item, frozen in its `contract` field, so later items build against something
  settled — not a guess.
- **Risk early.** Sensitive/unknown items go first, while the human is paying
  the most attention and the least is stacked on top.
- **Each item leaves the tree shippable** (gate green), so stopping after any
  item leaves working software plus a clean patch.

`done_when` is the tick's exit test; write it so the implementer cannot
mis-guess intent. Mark `sensitive` explicitly (copy the zone name from the
knowledge section) — the tick uses it to decide whether to pay for an
independent review. Hardening items (from init's mechanization proposals,
fallow findings, `/anakin harden`) use the same shape and the same list.

## Sanity pass (inline — no critic agent)

Re-read the items once: disjoint (no two items edit the same file for the same
reason), contracts defined before used, every acceptance criterion covered by
some item's done_when, no item secretly two items. Fix what you find.

## The approval gate

Present the mini-spec and items, then STOP and wait. On approval:
`task approve --id <id>` (records the baseline HEAD), then
`journal append` an `approval` entry ("approved by <name>, <date>"). If the
human answers with edits, treat the edits as the answer and re-present. Do not
start the first tick without approval.
```

- [ ] **Step 2: Write `skills/anakin/references/knowledge.md`** (replace entire file)

```markdown
# Init: obtain the repo's knowledge

Goal: after init, any fresh context can act like an engineer who already knows
this repo — from one `recall` call. Everything here is learned from the code,
never invented. Nothing is written inside the repo.

## 1. Register and discover the gate

`init --repo .` registers the project (identity = origin URL, so clones and
moves are the same project). Then find the commands that already define
"correct" here: typecheck, lint, test, build — from package.json scripts,
Makefile, CI config, whatever the repo actually uses. If `fallow` is on PATH
and the repo has (or can trivially take) a `.fallowrc`, include
`fallow audit --gate new-only` as a structural step.

Store them via `gate set` (stdin JSON: `[{command, reason}]`, ordered). Then
run the whole gate once. It must be green before any factory work: a red
baseline → report the failures and stop — fixing it is the human's call (they
may make it the first task).

## 2. Map the architecture into knowledge sections

Prefer `repomap` when available (`repomap index`, then `repomap ask` /
`repomap graph`). Otherwise dispatch read-only Explore scouts. Either way you
are extracting facts; every claim must be checkable against a file path.

Store each fact via `knowledge set` (stdin JSON: kind, title, body,
paths_glob, verified_sha = current HEAD). Kinds:

- `layout` — what each top-level module owns, one section per area, with
  `paths_glob` covering it (globs are what scope staleness checks later —
  set them carefully).
- `boundary` — dependency rules the code actually observes ("domain/ never
  imports infra/"). Only rules the code follows today or the human states;
  note violations honestly. Boundaries are included in every tick's packet.
- `convention` — naming, error handling, test placement; the dominant pattern
  a new change is expected to follow.
- `sensitive_zone` — paths where a defect is expensive: auth, money,
  migrations, public API contracts, data deletion. Specific paths, not vibes.
  These trigger independent review on ticks and are in every packet.
- `gotcha` — real, non-obvious traps only.

Keep bodies short — a map, not a wiki: point to files rather than restating
them. Aim for what v1 fit in ~150 lines total.

## 3. Mechanize what deserves it

For each boundary that matters and is cheap to enforce, propose a hardening
item (an eslint `no-restricted-imports` rule, a fallow boundary, a failing
test) — it goes into the first task's items or a dedicated hardening task,
approved like anything else. A boundary lives in a tool someone else
maintains, or it lives in a knowledge section — never in a bespoke engine.

## Maintaining the map (every phase, forever)

- The tick checks `knowledge stale --paths <item files>` before building;
  stale sections get re-verified (repomap or a quick read) and re-stamped via
  `knowledge set` with the new `verified_sha`.
- When a tick teaches something a newcomer would need, add it — the smallest
  edit that captures the fact.
- When reality contradicts the map, the map is wrong: fix it in the same tick
  and say so in the journal. A confident stale map is worse than no map.
- Cross-project standing preferences of the human (dependency policy, style
  instincts) belong in `prefs set`, not per-project sections.
```

- [ ] **Step 3: Write `skills/anakin/references/tick.md`** (replace entire file)

```markdown
# Tick: one item, one verified diff, no commit

You are a fresh context. Everything you need is in the recall packet;
everything you learn worth keeping goes back into the DB. Do the steps in
order — the order is the design. `$DB` below means
`bun <skill>/scripts/anakin-db.ts`.

## 1. Recall

`$DB recall --repo .` — one call: task, next item, gate, scoped knowledge,
journal tail, open questions, expected tree state, prefs, and FTS hits from
past ticks ("have we seen this before" — read them, they are free experience).
If the last entry is a stop waiting on the human and nothing has changed, stop
again with the same ask rather than guessing.

## 2. Reconcile the tree

Compute `git diff HEAD | shasum -a 256` and compare with the packet's
`expected_tree_hash` (also check HEAD vs `expected_head_sha`):

- **Hashes match** (or both empty) → proceed.
- **Tree differs** → the human edited mid-task. Read their changes
  (`git diff HEAD`), note them in this tick's journal entry, and continue —
  unless they conflict with the current item, in which case journal the
  conflict and stop cleanly. Never revert human edits.
- **HEAD moved** past `expected_head_sha` → the human committed; recall has
  already reconciled task states. Treat the new HEAD as the new baseline
  reality and re-check staleness.

## 3. Verify the map where you'll work

`$DB knowledge stale --repo . --paths <item files>`. For each stale section:
re-check via repomap or a quick read, `knowledge set` the corrected body with
the new `verified_sha`. Building on a stale map is how factories produce
confident nonsense.

## 4. Build — in this context

Implement the item yourself. Follow its `done_when` and `contract` literally;
follow the packet's conventions and boundaries; match the surrounding code's
style; honor global prefs. Prefer the boring implementation: YAGNI, stdlib
before dependency, the smallest correct change; a new runtime dependency needs
a one-line justification in the journal. Scouts (read-only subagents) are for
reconnaissance you'd otherwise pay a lot of context for — never for writing
code. If mid-build the item turns out to be two items or contradicts the
mini-spec: journal it, propose the split/change, stop for the human.

## 5. Gate

Run every command from the packet's `gate` list, in order. Red → fix and
rerun. After three genuinely different fix attempts on the same failure:
journal a `stop` entry with the exact failing command and output, leave the
tree as-is, stop. Never satisfy the gate by weakening it — no editing gate
rows, disabling rules, skipping tests, or loosening configs; that green would
be a lie.

## 6. Self-review

Read the item's diff fresh, as a reviewer, against three things: `done_when`,
the packet's conventions and boundaries, and the mini-spec's non-goals. Delete
anything the diff added that the item didn't need — dead flags, stray helpers,
drive-by edits.

## 7. Independent review — only when marked sensitive

If the item has `sensitive` set (or the diff unexpectedly touched a
sensitive_zone's paths), dispatch exactly one fresh-context reviewer subagent
with the diff, the item text, and the relevant knowledge sections. Its brief:
*try to refute this change — find a concrete input or state where it does the
wrong thing; "looks fine" is a failed review only if you genuinely tried.*
Fix real findings and rerun the gate; journal findings you dispute rather
than silently dropping them. Non-sensitive items skip this step.

## 8. Persist — no commit

Write the cumulative task patch to a temp file:
`git diff <task baseline_sha> > /tmp/anakin-patch.diff` (use your scratchpad
dir). Then:

1. `$DB journal append --repo . --patch-file <patch>` with stdin JSON:
   `task_id`, `item_id`, `entry_kind: "tick"`, `gate_verdict`, `decisions`
   (anything a future tick or human needs), `questions` (or empty),
   `head_sha` (`git rev-parse HEAD`), `tree_hash`
   (`git diff HEAD | shasum -a 256`, first field).
2. `$DB item check --repo . --id <item> --journal <journal id from step 1>`.
3. `knowledge set` anything durable this tick taught.

The tree keeps all changes uncommitted — that is the design, not an accident.
If the CLI exits non-zero citing a spool file, stop cleanly and tell the human
where the payload is.

## 9. Hand off

Todo items remain → return to `commands/anakin.md` pacing and schedule the
next tick. This was the last item → task close (SKILL.md phase routing): full
gate once more on the whole tree, reviewer-oriented summary of the combined
diff (per item: what changed, why, where), `task close`, journal a `note`
with the summary, stop for human review and commit. Any stop condition → stop
cleanly with the journal already telling the human everything.
```

- [ ] **Step 4: Delete merged files**

```bash
git rm skills/anakin/references/conceive.md skills/anakin/references/decompose.md
```

- [ ] **Step 5: Verify no committed-state mentions remain, and re-run the token audit**

Run: `grep -rn "\.anakin/" skills/anakin/ --include="*.md" | grep -v "~/.anakin" | grep -v import`
Expected: no hits outside import/migration wording (spec acceptance 6 — legacy dir may only appear in the import context).

Run: `wc -c skills/anakin/SKILL.md skills/anakin/commands/anakin.md skills/anakin/references/tick.md`
Expected: total under ~16,000 chars.

- [ ] **Step 6: Commit**

```bash
git add skills/anakin/references/
git commit -m "feat(anakin): v2 references — merged intake, DB knowledge, commitless tick"
```

---

### Task 9: README update

**Files:**
- Modify: `README.md` (anakin section only)

**Interfaces:** none.

- [ ] **Step 1: Update the anakin bullets/section**

In the top skills list, replace the `anakin` bullet with:

```markdown
- **`anakin`** — the current factory. Minimal and knowledge-first: it learns the repo's real
  architecture into a global SQLite database (`~/.anakin/anakin.db` — nothing is ever written
  or committed inside your repo), gates every tick on the repo's own toolchain, builds in the
  main context (subagents only read), and journals one verified patch per tick. The human
  reviews and commits each finished task. Start here.
```

In the "What anakin is" section, replace the two paragraphs with:

```markdown
One approved task becomes a reviewed diff through small, verified, journaled ticks. One tick =
one item = one verified patch; between ticks the context is discarded and the global database
at `~/.anakin/anakin.db` (projects, tasks, items, knowledge sections, gate commands, journal
with full-text search, cross-project prefs) is the only memory. The factory never commits and
never creates files in the repo — each tick's diff is journaled as a patch, and the human
reviews and commits when the task closes.

The operating principles: context is finite (a tick rehydrates from one `recall` call); the
repo belongs to the human (no factory files, no factory commits); knowledge is obtained from
the repo, not imposed as invariants (boundaries worth enforcing get mechanized into lint
rules, fallow config, or real tests); determinism beats discipline (the repo's own
typecheck/lint/tests are the gate, and a red gate spawns zero reviewers); the main context
builds; ask at intake, never mid-tick.

Run it with `/anakin` driven by `/loop`. Memory access goes through
`skills/anakin/scripts/anakin-db.ts` (bun, zero dependencies). See `skills/anakin/SKILL.md`;
design: `docs/superpowers/specs/2026-07-17-anakin-v2-sqlite-factory-design.md`.
```

In the repository-layout tree, update the anakin subtree to:

```
│   ├── anakin/
│   │   ├── SKILL.md                 # principles, DB memory, phase routing, stop conditions
│   │   ├── commands/
│   │   │   └── anakin.md            # /anakin: one step per firing, pacing, arguments
│   │   ├── references/
│   │   │   ├── knowledge.md         # init: gate discovery, knowledge sections, mechanization
│   │   │   ├── task.md              # intake: interview → mini-spec → items → approval
│   │   │   └── tick.md              # recall → reconcile → build → gate → review → persist
│   │   └── scripts/
│   │       ├── anakin-db.ts         # the memory CLI (bun:sqlite, zero deps)
│   │       ├── schema.sql           # tables + FTS5
│   │       └── anakin-db.test.ts    # bun test suite
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(anakin): README reflects v2 — global SQLite memory, commitless ticks"
```

---

### Task 10: Rehearsal run (spec acceptance 3–5) + record

**Files:**
- Create: `docs/anakin-dogfood-2.md`

**Interfaces:** consumes the finished CLI and skill files.

This task is executed by the main agent following the new skill files literally, in the session scratchpad (never `/tmp` per user config, never inside agentique). Use `ANAKIN_HOME=<scratchpad>/anakin-home` for the whole rehearsal so the real `~/.anakin` stays untouched.

- [ ] **Step 1: Build a scratch repo with a legacy `.anakin/`**

In the scratchpad: create a tiny bun/node repo (2 source files, 1 passing test, `package.json` with a `test` script), `git init`, commit. Add a v1-style `.anakin/` directory (GATE.md with the test command, KNOWLEDGE.md with Layout + Boundaries + `verified:` stamps, ROADMAP.md with one checked and two unchecked items, JOURNAL.md with one entry), commit it.

- [ ] **Step 2: Acceptance 5 — import**

Run `ANAKIN_HOME=... bun skills/anakin/scripts/anakin-db.ts import --repo <scratch>`.
Verify with `gate get`, `knowledge list`, `task show`, `item list`: gate commands, sections, the approved "Imported roadmap" task with 3 items (1 done), journal note present. Then delete `.anakin/` from the scratch repo and commit that deletion (as the human would).

- [ ] **Step 3: Acceptance 3 — two ticks + close, zero files, zero commits**

Following `references/tick.md` literally, execute the two todo items as two ticks (recall → reconcile → build → gate → self-review → persist via `journal append` + `item check`, no commit), then the close step (`task close`, summary journaled). After each tick verify:
- `git -C <scratch> status --porcelain` shows only source-file modifications — no new untracked factory files;
- `git -C <scratch> log --oneline` count unchanged since Step 2 (factory made zero commits);
- `recall` returns the next item with `expected_tree_hash` matching `git diff HEAD | shasum -a 256`.

- [ ] **Step 4: Acceptance 4 — human commit flips the task**

As the human: `git add -A && git commit -m "ship imported roadmap"` in the scratch repo. Run `recall` again. Verify: `task` is null, no tree-mismatch warning is implied (`expected_tree_hash` null), and `task show --id` reports `committed`.

- [ ] **Step 5: Acceptance 1–2 sanity + full suite**

Run: `cd skills/anakin/scripts && bun test`
Expected: PASS, all tests.

- [ ] **Step 6: Write `docs/anakin-dogfood-2.md`**

Record: date, scratch-repo shape, a table of the five spec acceptance criteria with pass/fail and the exact evidence commands, anything the rehearsal exposed (and the fix, if a skill file needed editing — fix it in the same commit).

- [ ] **Step 7: Commit**

```bash
git add docs/anakin-dogfood-2.md
git commit -m "test(anakin): v2 rehearsal — import, commitless ticks, committed-flip verified"
```

---

## Self-review notes

- **Spec coverage:** storage layout + schema → Task 1; CLI subcommands `init/recall/task/item/knowledge/journal/gate/import/status` + prefs → Tasks 1–6; spool fallback → Tasks 1 (helper) and 4 (test); workflow/phases/tick → Tasks 7–8; skill-changes list (SKILL, task.md merge, knowledge, tick, command, scripts) → Tasks 7–8 + 1–6; README → Task 9; acceptance 1–6 → Tasks 1–6 tests (1–2), Task 10 (3–5), Task 8 Step 5 grep (6).
- **Non-goals honored:** no queue, no export, no vader changes, no per-tick human review.
- **Type consistency:** CLI flag names (`--repo`, `--id`, `--task`, `--journal`, `--paths`, `--key`, `--patch-file`), status values, kinds, and recall packet keys are identical across tasks and referenced verbatim in the markdown of Tasks 7–8.
- **Known simplification:** patch-body pruning (spec "Retention") is not implemented — retention is a policy the human can apply later with one SQL statement; nothing depends on it. Recorded here so it isn't mistaken for an omission.
