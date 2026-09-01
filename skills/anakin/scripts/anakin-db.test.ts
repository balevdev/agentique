import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

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

    // a glob with ? is a glob wildcard, not a regex quantifier (and must not throw)
    run(["knowledge", "set", "--repo", repo],
      JSON.stringify({ kind: "gotcha", title: "q", body: "b", paths_glob: "?.txt", verified_sha: sha }));
    const q = run(["knowledge", "stale", "--repo", repo, "--paths", "a.txt"]);
    expect(q.code).toBe(0);
    expect(q.json().map((s: any) => s.title).sort()).toEqual(["q", "root"]);
  });
});

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

describe("mission lifecycle", () => {
  const PLAN = ["plan", "implement", "gate", "verify"];

  function seedApproved(repo: string) {
    run(["init", "--repo", repo]);
    const t = run(["task", "new", "--repo", repo],
      JSON.stringify({ title: "wire the flux capacitor", description: "shielding needed",
        mini_spec: "purpose", stage_plan: PLAN })).json();
    run(["task", "approve", "--repo", repo, "--id", String(t.id)]);
    return t;
  }

  function openMission(repo: string, taskId: number) {
    return run(["mission", "open", "--repo", repo],
      JSON.stringify({ task_id: taskId, slug: "flux", stage_plan: PLAN,
        dir: ".troopers/2026-09-01-flux" })).json();
  }

  test("open: creates running mission, task → in_progress, stage_plan lands in mini_spec, duplicates refused", () => {
    const repo = makeRepo();
    const t = seedApproved(repo);
    expect(t.mini_spec).toContain('stage_plan: ["plan","implement","gate","verify"]');
    const m = openMission(repo, t.id);
    expect(m.status).toBe("running");
    expect(m.stage_cursor).toBe(0);
    expect(run(["task", "show", "--repo", repo]).json().status).toBe("in_progress");
    // a second running mission for the same task is refused
    expect(run(["mission", "open", "--repo", repo],
      JSON.stringify({ task_id: t.id, slug: "again", stage_plan: PLAN, dir: ".troopers/x" })).code).not.toBe(0);
  });

  test("stage: passing verdicts advance the cursor, failing ones hold it, fix loops move it back", () => {
    const repo = makeRepo();
    const m = openMission(repo, seedApproved(repo).id);
    const stage = (s: string, attempt: number, verdict?: string) =>
      run(["mission", "stage", "--repo", repo],
        JSON.stringify({ mission_id: m.id, stage: s, attempt, verdict, content: `## Handoff\n${s} ${attempt}` }));
    const cursor = () => run(["mission", "show", "--repo", repo, "--id", String(m.id)]).json().stage_cursor;
    stage("plan", 1);
    stage("implement", 1);
    stage("gate", 1, "green");
    expect(cursor()).toBe(3);
    stage("verify", 1, "FAIL");
    // FAIL holds the cursor on verify — a crash resumes inside the fix loop,
    // never past it toward close
    expect(cursor()).toBe(3);
    stage("implement", 2); // fix loop re-runs implement
    const shown = run(["mission", "show", "--repo", repo, "--id", String(m.id)]).json();
    expect(shown.stage_cursor).toBe(2);
    expect(shown.handoffs.map((h: any) => [h.stage, h.attempt])).toEqual(
      [["plan", 1], ["implement", 1], ["gate", 1], ["verify", 1], ["implement", 2]]);
    expect(shown.handoffs[3].verdict).toBe("FAIL");
    // an ad-hoc audit outside the plan is accepted and leaves the cursor alone
    expect(run(["mission", "stage", "--repo", repo],
      JSON.stringify({ mission_id: m.id, stage: "audit", attempt: 1, verdict: "PASS",
        content: "## Handoff\nsensitive-zone drift audited" })).code).toBe(0);
    expect(cursor()).toBe(2);
    // any other stage outside the plan is refused
    expect(run(["mission", "stage", "--repo", repo],
      JSON.stringify({ mission_id: m.id, stage: "brainstorm", attempt: 1, content: "x" })).code).not.toBe(0);
    // empty content is refused — the handoff is the memory
    expect(run(["mission", "stage", "--repo", repo],
      JSON.stringify({ mission_id: m.id, stage: "verify", attempt: 2, content: "  " })).code).not.toBe(0);
  });

  test("stage: an early in-plan audit and free-text verdicts never teleport the cursor", () => {
    const repo = makeRepo();
    run(["init", "--repo", repo]);
    const plan = ["plan", "implement", "gate", "verify", "audit"];
    // prose mentioning stage_plan above the appended line must not shadow it
    const t = run(["task", "new", "--repo", repo],
      JSON.stringify({ title: "sensitive rework", mini_spec: 'purpose\nstage_plan: ["implement"]',
        stage_plan: plan })).json();
    run(["task", "approve", "--repo", repo, "--id", String(t.id)]);
    const m = run(["mission", "open", "--repo", repo],
      JSON.stringify({ task_id: t.id, slug: "s", stage_plan: plan, dir: ".troopers/z" })).json();
    expect(m.status).toBe("running"); // the appended (last) stage_plan line is the approved one
    const stage = (s: string, attempt: number, verdict?: string) =>
      run(["mission", "stage", "--repo", repo],
        JSON.stringify({ mission_id: m.id, stage: s, attempt, verdict, content: `## Handoff\n${s}` }));
    const cursor = () => run(["mission", "show", "--repo", repo, "--id", String(m.id)]).json().stage_cursor;
    stage("plan", 1);
    stage("implement", 1);
    // sensitive-zone drift: the auditor runs early even though audit IS in the
    // plan — recorded, but the cursor must not jump past gate and verify
    stage("audit", 1, "OK");
    expect(cursor()).toBe(2);
    // verdicts are free text: a decorated FAIL still holds the cursor…
    stage("gate", 1, "FAIL — 2 commands red");
    expect(cursor()).toBe(2);
    stage("gate", 2, "green");
    // …and a PASS that merely mentions red still advances
    stage("verify", 1, "PASS (red gate was fixed)");
    expect(cursor()).toBe(4);
    // a task cannot slip into review while its mission still runs
    expect(run(["task", "close", "--repo", repo, "--id", String(t.id)]).code).not.toBe(0);
    expect(run(["task", "show", "--repo", repo, "--id", String(t.id)]).json().status).toBe("in_progress");
  });

  test("open: refuses tasks that are not approved/in_progress and stage plans that differ from the approved one", () => {
    const repo = makeRepo();
    run(["init", "--repo", repo]);
    const t = run(["task", "new", "--repo", repo],
      JSON.stringify({ title: "guarded", mini_spec: "purpose", stage_plan: PLAN })).json();
    // draft task → refused
    expect(run(["mission", "open", "--repo", repo],
      JSON.stringify({ task_id: t.id, slug: "s", stage_plan: PLAN, dir: ".troopers/x" })).code).not.toBe(0);
    run(["task", "approve", "--repo", repo, "--id", String(t.id)]);
    // a plan that differs from the approved stage_plan line → refused
    expect(run(["mission", "open", "--repo", repo],
      JSON.stringify({ task_id: t.id, slug: "s", stage_plan: ["implement", "gate", "verify"],
        dir: ".troopers/x" })).code).not.toBe(0);
    // the approved plan opens fine; a review task later refuses again
    const m = run(["mission", "open", "--repo", repo],
      JSON.stringify({ task_id: t.id, slug: "s", stage_plan: PLAN, dir: ".troopers/x" })).json();
    expect(m.status).toBe("running");
    run(["mission", "stop", "--repo", repo, "--id", String(m.id)]);
    run(["task", "close", "--repo", repo, "--id", String(t.id)]);
    expect(run(["mission", "open", "--repo", repo],
      JSON.stringify({ task_id: t.id, slug: "s2", stage_plan: PLAN, dir: ".troopers/y" })).code).not.toBe(0);
  });

  test("stage: a mission from another project is out of reach", () => {
    const repoA = makeRepo("git@github.com:acme/a.git");
    const repoB = makeRepo("git@github.com:acme/b.git");
    const m = openMission(repoA, seedApproved(repoA).id);
    run(["init", "--repo", repoB]);
    const r = run(["mission", "stage", "--repo", repoB],
      JSON.stringify({ mission_id: m.id, stage: "plan", attempt: 1, content: "## Handoff\nx" }));
    expect(r.code).not.toBe(0);
    expect(run(["mission", "show", "--repo", repoA, "--id", String(m.id)]).json().handoffs).toEqual([]);
  });

  test("close: ingests *.md artifacts, marks closed, re-close replaces instead of duplicating", () => {
    const repo = makeRepo();
    const m = openMission(repo, seedApproved(repo).id);
    const dir = join(repo, ".troopers", "2026-09-01-flux");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "00-intel.md"), "# intel\nflux capacitor shielding facts");
    writeFileSync(join(dir, "02-plan.md"), "# plan\nshield the flux capacitor with lead");
    const r = run(["mission", "close", "--repo", repo, "--dir", ".troopers/2026-09-01-flux"]);
    expect(r.code).toBe(0);
    expect(r.json().ingested).toEqual(["00-intel.md", "02-plan.md"]);
    expect(r.err).toContain("delete");
    expect(run(["mission", "show", "--repo", repo, "--id", String(m.id)]).json().status).toBe("closed");
    // crash before dir deletion → close runs again, idempotently
    writeFileSync(join(dir, "02-plan.md"), "# plan v2\nshield the flux capacitor with lead");
    expect(run(["mission", "close", "--repo", repo, "--dir", ".troopers/2026-09-01-flux"]).code).toBe(0);
    const db = new Database(join(home, "anakin.db"), { readonly: true });
    const rows = db.query("SELECT filename, body FROM artifacts WHERE mission_id = ? ORDER BY filename").all(m.id) as any[];
    // the FTS index was told about the replacement too — no stale rowids linger
    const ftsCount = (db.query("SELECT COUNT(*) AS c FROM artifacts_fts WHERE artifacts_fts MATCH 'lead'").get() as any).c;
    db.close();
    expect(rows.map(a => a.filename)).toEqual(["00-intel.md", "02-plan.md"]); // replaced, not duplicated
    expect(rows[1].body).toContain("v2");
    expect(ftsCount).toBe(1);
  });

  test("ingest: persists artifacts mid-mission; show --artifacts returns their bodies", () => {
    const repo = makeRepo();
    const m = openMission(repo, seedApproved(repo).id);
    const dir = join(repo, ".troopers", "2026-09-01-flux");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "00-intel.md"), "# intel\nflux facts");
    writeFileSync(join(dir, "01-brainstorm.md"), "# brainstorm\ndirection: shield it");
    // --file ingests just the artifact that landed
    const r1 = run(["mission", "ingest", "--repo", repo, "--dir", ".troopers/2026-09-01-flux", "--file", "01-brainstorm.md"]);
    expect(r1.code).toBe(0);
    expect(r1.json().ingested).toEqual(["01-brainstorm.md"]);
    expect(run(["mission", "show", "--repo", repo, "--id", String(m.id)]).json().status).toBe("running");
    // re-ingesting an updated body replaces, never duplicates
    writeFileSync(join(dir, "01-brainstorm.md"), "# brainstorm v2\ndirection: shield it harder");
    run(["mission", "ingest", "--repo", repo, "--dir", ".troopers/2026-09-01-flux", "--file", "01-brainstorm.md"]);
    // no --file ingests the whole dir; --artifacts restores the bodies
    run(["mission", "ingest", "--repo", repo, "--dir", ".troopers/2026-09-01-flux"]);
    const shown = run(["mission", "show", "--repo", repo, "--id", String(m.id), "--artifacts"]).json();
    expect(shown.artifacts.map((a: any) => a.filename)).toEqual(["00-intel.md", "01-brainstorm.md"]);
    expect(shown.artifacts[1].body).toContain("harder");
    // plain show stays lean — no bodies unless asked
    expect(run(["mission", "show", "--repo", repo, "--id", String(m.id)]).json().artifacts).toBeUndefined();
    // a bare --file (no value) must fail loudly, never silently ingest the whole dir
    const bare = run(["mission", "ingest", "--repo", repo, "--dir", ".troopers/2026-09-01-flux", "--file"]);
    expect(bare.code).toBe(1);
    expect(bare.err).toContain("--file requires a filename");
  });

  test("a contentless artifacts_fts left by the first v2 cut is migrated and rebuilt", () => {
    const repo = makeRepo();
    const m = openMission(repo, seedApproved(repo).id);
    const dir = join(repo, ".troopers", "2026-09-01-flux");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "02-plan.md"), "# plan\nshield the flux capacitor");
    run(["mission", "close", "--repo", repo, "--dir", ".troopers/2026-09-01-flux"]);
    // regress the index to the shape the first v2 cut shipped
    const db = new Database(join(home, "anakin.db"));
    db.exec(`DROP TABLE artifacts_fts;
      CREATE VIRTUAL TABLE artifacts_fts USING fts5(filename, body, content='');`);
    db.close();
    run(["status"]); // any CLI touch migrates on open
    const db2 = new Database(join(home, "anakin.db"), { readonly: true });
    const sql = (db2.query("SELECT sql FROM sqlite_master WHERE name = 'artifacts_fts'").get() as any).sql;
    const hits = db2.query("SELECT rowid FROM artifacts_fts WHERE artifacts_fts MATCH 'shield'").all() as any[];
    db2.close();
    expect(sql).toContain("content='artifacts'");
    expect(hits.length).toBe(1);
    expect(hits[0].rowid).toBe(
      (run(["mission", "show", "--repo", repo, "--id", String(m.id), "--artifacts"]).json().artifacts[0].id));
  });

  test("ingested artifacts are FTS-searchable from the next task's recall", () => {
    const repo = makeRepo();
    const t = seedApproved(repo);
    const m = openMission(repo, t.id);
    const dir = join(repo, ".troopers", "2026-09-01-flux");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "02-plan.md"), "# plan\nthe capacitor needs a shielding layer");
    run(["mission", "close", "--repo", repo, "--dir", ".troopers/2026-09-01-flux"]);
    // close out the task the v1 way: journal with head, review, human commits
    const head = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
    run(["journal", "append", "--repo", repo],
      JSON.stringify({ task_id: t.id, entry_kind: "tick", gate_verdict: "green", head_sha: head, tree_hash: "TH" }));
    run(["task", "close", "--repo", repo, "--id", String(t.id)]);
    writeFileSync(join(repo, "b.txt"), "human work\n");
    Bun.spawnSync(["git", "-C", repo, "add", "-A"]);
    Bun.spawnSync(["git", "-C", repo, "commit", "-qm", "human: ship"]);
    run(["recall", "--repo", repo]); // flips the committed task out of the way
    // a later task about the same subject finds the past mission's artifact
    const t2 = run(["task", "new", "--repo", repo],
      JSON.stringify({ title: "capacitor shielding follow-up", description: "improve the shielding" })).json();
    run(["task", "approve", "--repo", repo, "--id", String(t2.id)]);
    const r = run(["recall", "--repo", repo]).json();
    expect(r.artifact_hits.length).toBeGreaterThan(0);
    expect(r.artifact_hits[0].filename).toBe("02-plan.md");
    expect(r.artifact_hits[0].mission_id).toBe(m.id);
    expect(r.artifact_hits[0].excerpt).toContain("shielding layer");
  });

  test("stop: marks a running mission stopped; stopped/closed missions refuse further writes", () => {
    const repo = makeRepo();
    const m = openMission(repo, seedApproved(repo).id);
    expect(run(["mission", "stop", "--repo", repo, "--id", String(m.id)]).json().status).toBe("stopped");
    expect(run(["mission", "stop", "--repo", repo, "--id", String(m.id)]).code).not.toBe(0);
    expect(run(["mission", "stage", "--repo", repo],
      JSON.stringify({ mission_id: m.id, stage: "plan", attempt: 1, content: "x" })).code).not.toBe(0);
    expect(run(["mission", "show", "--repo", repo]).json()).toBeNull(); // no active mission left
  });

  test("status reports the active mission per project", () => {
    const repo = makeRepo();
    const t = seedApproved(repo);
    const m = openMission(repo, t.id);
    run(["mission", "stage", "--repo", repo],
      JSON.stringify({ mission_id: m.id, stage: "plan", attempt: 1, content: "## Handoff\nok" }));
    const s = run(["status"]).json();
    expect(s[0].active_mission.id).toBe(m.id);
    expect(s[0].active_mission.stage_plan).toEqual(PLAN);
    expect(s[0].active_mission.stage_cursor).toBe(1);
  });

  test("mission open payload is spooled when the DB is unwritable", () => {
    const repo = makeRepo();
    const t = seedApproved(repo);
    rmSync(join(home, "anakin.db-wal"), { force: true });
    rmSync(join(home, "anakin.db-shm"), { force: true });
    chmodSync(join(home, "anakin.db"), 0o444);
    const r = run(["mission", "open", "--repo", repo],
      JSON.stringify({ task_id: t.id, slug: "precious-mission", stage_plan: PLAN, dir: ".troopers/x" }));
    chmodSync(join(home, "anakin.db"), 0o644);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("spooled");
    const spooled = readdirSync(join(home, "spool"));
    expect(spooled.length).toBe(1);
    expect(readFileSync(join(home, "spool", spooled[0]), "utf8")).toContain("precious-mission");
  });

  test("a v1 database with no mission tables still opens and recalls", () => {
    const repo = makeRepo();
    // Build a genuine v1 DB: old tables only, seeded directly.
    const db = new Database(join(home, "anakin.db"), { create: true });
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, origin_url TEXT, abs_path TEXT NOT NULL, name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', mini_spec TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft','approved','in_progress','review','committed')),
        baseline_sha TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE items (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id),
        ordinal INTEGER NOT NULL, title TEXT NOT NULL, files TEXT NOT NULL DEFAULT '',
        done_when TEXT NOT NULL DEFAULT '', contract TEXT, sensitive TEXT,
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done')), journal_id INTEGER);
      CREATE TABLE knowledge_sections (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, paths_glob TEXT NOT NULL DEFAULT '',
        verified_sha TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (project_id, kind, title));
      CREATE TABLE journal (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        task_id INTEGER REFERENCES tasks(id), item_id INTEGER REFERENCES items(id),
        entry_kind TEXT NOT NULL CHECK (entry_kind IN ('tick','approval','stop','note')),
        gate_verdict TEXT, decisions TEXT NOT NULL DEFAULT '', questions TEXT NOT NULL DEFAULT '',
        patch TEXT, head_sha TEXT, tree_hash TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE VIRTUAL TABLE journal_fts USING fts5(decisions, questions, item_title, content='');
      CREATE TABLE gate_commands (project_id TEXT NOT NULL REFERENCES projects(id), ordinal INTEGER NOT NULL,
        command TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', PRIMARY KEY (project_id, ordinal));
      CREATE TABLE prefs (key TEXT PRIMARY KEY, body TEXT NOT NULL);
    `);
    db.run("INSERT INTO projects (id, origin_url, abs_path, name) VALUES ('deadbeefdeadbeef', NULL, ?, 'legacy')", [repo]);
    db.run("INSERT INTO tasks (project_id, title, status, baseline_sha) VALUES ('deadbeefdeadbeef', 'old capacitor work', 'in_progress', 'abc')");
    db.run("INSERT INTO items (task_id, ordinal, title, status) VALUES (1, 1, 'legacy item', 'done')");
    db.run("INSERT INTO journal (project_id, task_id, entry_kind, decisions) VALUES ('deadbeefdeadbeef', 1, 'tick', 'legacy decision')");
    db.close();

    const r = run(["recall", "--repo", repo]);
    expect(r.code).toBe(0);
    const packet = r.json();
    expect(packet.task.title).toBe("old capacitor work");
    expect(packet.mission).toBeNull();
    expect(packet.journal_tail[0].decisions).toBe("legacy decision");
    // legacy items remain readable (history / import path)
    expect(run(["item", "list", "--repo", repo, "--task", "1"]).json()[0].title).toBe("legacy item");
  });
});

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
    // a tick entry moves an approved task to in_progress
    expect(run(["task", "show", "--repo", repo]).json().status).toBe("in_progress");
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
    const spooled = readdirSync(join(home, "spool"));
    expect(spooled.length).toBe(1);
    const payload = JSON.parse(readFileSync(join(home, "spool", spooled[0]), "utf8"));
    expect(JSON.stringify(payload)).toContain("must not be lost");
  });
});

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
    const t = run(["task", "new", "--repo", repo],
      JSON.stringify({ title: "flux capacitor wiring", description: "wire the flux capacitor" })).json();
    run(["task", "approve", "--repo", repo, "--id", String(t.id)]);
    const it = run(["item", "add", "--repo", repo, "--task", String(t.id)],
      JSON.stringify({ ordinal: 1, title: "flux capacitor wiring", files: "src/flux.ts", done_when: "green" })).json();
    return { t, it, sha };
  }

  test("packet: task, mission (none yet), knowledge, prefs, FTS hits keyed off the task", () => {
    const repo = makeRepo();
    const { t } = seed(repo);
    // a past decision mentioning the same words, findable via FTS...
    run(["journal", "append", "--repo", repo],
      JSON.stringify({ task_id: t.id, entry_kind: "note", decisions: "flux capacitor needs shielding" }));
    // ...pushed beyond the 5-entry tail by newer unrelated entries (FTS is for old memory)
    for (let i = 0; i < 5; i++) {
      run(["journal", "append", "--repo", repo],
        JSON.stringify({ task_id: t.id, entry_kind: "note", decisions: `routine entry ${i}` }));
    }
    const r = run(["recall", "--repo", repo]).json();
    expect(r.task.id).toBe(t.id);
    expect(r.mission).toBeNull(); // no mission opened yet
    expect(r.gate).toHaveLength(1);
    const titles = r.knowledge.map((k: any) => k.title).sort();
    expect(titles).toEqual(["naming", "no-infra-in-domain", "unrelated"]);
    expect(r.prefs[0].body).toBe("boring code wins");
    expect(r.fts_hits.length).toBeGreaterThan(0);
    expect(r.fts_hits[0].decisions).toContain("shielding");
    expect(r.artifact_hits).toEqual([]);
  });

  test("packet: active mission state with persisted handoffs", () => {
    const repo = makeRepo();
    const { t } = seed(repo);
    const m = run(["mission", "open", "--repo", repo],
      JSON.stringify({ task_id: t.id, slug: "flux-wiring", stage_plan: ["plan", "implement", "gate", "verify"],
        dir: ".troopers/2026-09-01-flux-wiring" })).json();
    run(["mission", "stage", "--repo", repo],
      JSON.stringify({ mission_id: m.id, stage: "plan", attempt: 1, content: "## Handoff\nplan landed" }));
    run(["mission", "stage", "--repo", repo],
      JSON.stringify({ mission_id: m.id, stage: "implement", attempt: 1, verdict: "OK", content: "## Handoff\nbuilt" }));
    const r = run(["recall", "--repo", repo]).json();
    expect(r.task.status).toBe("in_progress");
    expect(r.mission.id).toBe(m.id);
    expect(r.mission.stage_plan).toEqual(["plan", "implement", "gate", "verify"]);
    expect(r.mission.stage_cursor).toBe(2);
    expect(r.mission.handoffs.map((h: any) => h.stage)).toEqual(["plan", "implement"]);
    expect(r.mission.handoffs[1].content).toContain("built");
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

  test("FTS hits are scoped to the project before the cap — a busy sibling cannot crowd them out", () => {
    const repoA = makeRepo("git@github.com:acme/a.git");
    const repoB = makeRepo("git@github.com:acme/b.git");
    run(["init", "--repo", repoB]);
    // the sibling project drowns the term well past any per-query cap
    for (let i = 0; i < 20; i++) {
      run(["journal", "append", "--repo", repoB],
        JSON.stringify({ entry_kind: "note", decisions: `flux capacitor chatter ${i}` }));
    }
    seed(repoA);
    run(["journal", "append", "--repo", repoA],
      JSON.stringify({ entry_kind: "note", decisions: "flux capacitor needs shielding" }));
    for (let i = 0; i < 5; i++) {
      run(["journal", "append", "--repo", repoA],
        JSON.stringify({ entry_kind: "note", decisions: `routine entry ${i}` }));
    }
    const r = run(["recall", "--repo", repoA]).json();
    expect(r.fts_hits.length).toBeGreaterThan(0);
    expect(r.fts_hits.every((e: any) => !e.decisions.includes("chatter"))).toBe(true);
    expect(r.fts_hits.some((e: any) => e.decisions.includes("shielding"))).toBe(true);
  });

  test("read commands on an unregistered repo route to init instead of registering it", () => {
    const repo = makeRepo();
    expect(run(["recall", "--repo", repo]).json()).toEqual({ project: null });
    expect(run(["task", "show", "--repo", repo]).code).not.toBe(0);
    expect(run(["task", "status", "--repo", repo]).code).not.toBe(0);
    expect(run(["gate", "get", "--repo", repo]).code).not.toBe(0);
    expect(run(["knowledge", "list", "--repo", repo]).code).not.toBe(0);
    expect(run(["mission", "show", "--repo", repo]).code).not.toBe(0);
    // none of that created a project row
    expect(run(["status"]).json()).toHaveLength(0);
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
    // the roadmap task re-enters intake as a draft — the human approves a
    // mini-spec and stage plan before any mission can open on it
    const t = run(["task", "show", "--repo", repo, "--id", "1"]).json();
    expect(t.title).toBe("Imported roadmap");
    expect(t.status).toBe("draft");
    expect(run(["mission", "open", "--repo", repo],
      JSON.stringify({ task_id: t.id, slug: "x", stage_plan: ["implement"], dir: ".troopers/x" })).code).not.toBe(0);
    const items = run(["item", "list", "--repo", repo, "--task", String(t.id)]).json();
    expect(items[0].status).toBe("done");
    expect(items[1].sensitive).toBe("public-api");
  });
});

describe("guardrails (code-review fixes)", () => {
  test("bare numeric flags are rejected, never coerced to row id 1", () => {
    const repo = makeRepo();
    run(["init", "--repo", repo]);
    const t = run(["task", "new", "--repo", repo], JSON.stringify({ title: "T" })).json();
    run(["task", "approve", "--repo", repo, "--id", String(t.id)]);
    const it = run(["item", "add", "--repo", repo, "--task", String(t.id)],
      JSON.stringify({ ordinal: 1, title: "a", files: "", done_when: "x" })).json();

    const badCheck = run(["item", "check", "--repo", repo, "--id", String(it.id), "--journal"]);
    expect(badCheck.code).not.toBe(0);
    expect(run(["item", "list", "--repo", repo, "--task", String(t.id)]).json()[0].status).toBe("todo");

    const badApprove = run(["task", "approve", "--repo", repo, "--id"]);
    expect(badApprove.code).not.toBe(0);
  });

  test("status transitions are guarded: approve only drafts, close only active", () => {
    const repo = makeRepo();
    run(["init", "--repo", repo]);
    const t = run(["task", "new", "--repo", repo], JSON.stringify({ title: "T" })).json();
    run(["task", "approve", "--repo", repo, "--id", String(t.id)]);
    run(["task", "close", "--repo", repo, "--id", String(t.id)]);
    // re-approving a task in review must be refused, not silently resurrected
    const r = run(["task", "approve", "--repo", repo, "--id", String(t.id)]);
    expect(r.code).not.toBe(0);
    expect(run(["task", "show", "--repo", repo, "--id", String(t.id)]).json().status).toBe("review");
    // closing a review task again is also refused
    expect(run(["task", "close", "--repo", repo, "--id", String(t.id)]).code).not.toBe(0);
  });

  test("task new payload is spooled when the DB is unwritable", () => {
    const repo = makeRepo();
    run(["init", "--repo", repo]);
    rmSync(join(home, "anakin.db-wal"), { force: true });
    rmSync(join(home, "anakin.db-shm"), { force: true });
    chmodSync(join(home, "anakin.db"), 0o444);
    const r = run(["task", "new", "--repo", repo], JSON.stringify({ title: "precious ticket" }));
    chmodSync(join(home, "anakin.db"), 0o644);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("spooled");
    const spooled = readdirSync(join(home, "spool"));
    expect(spooled.length).toBe(1);
    expect(readFileSync(join(home, "spool", spooled[0]), "utf8")).toContain("precious ticket");
  });

  test("journal append with a missing patch file spools instead of crashing", () => {
    const repo = makeRepo();
    run(["init", "--repo", repo]);
    const r = run(["journal", "append", "--repo", repo, "--patch-file", join(home, "nope.diff")],
      JSON.stringify({ entry_kind: "note", decisions: "keep me" }));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("spooled");
    const spooled = readdirSync(join(home, "spool"));
    expect(readFileSync(join(home, "spool", spooled[0]), "utf8")).toContain("keep me");
  });
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
