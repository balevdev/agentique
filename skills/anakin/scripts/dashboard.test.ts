import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
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

  test("project payload carries missions with handoffs and ingested artifacts", async () => {
    const { repo, project, task } = seed();
    const m = run(["mission", "open", "--repo", repo],
      JSON.stringify({ task_id: task.id, slug: "flux", stage_plan: ["implement", "gate", "verify"],
        dir: ".troopers/2026-09-01-flux" })).json();
    run(["mission", "stage", "--repo", repo],
      JSON.stringify({ mission_id: m.id, stage: "implement", attempt: 1, verdict: "OK", content: "## Handoff\nbuilt" }));
    const dir = join(repo, ".troopers", "2026-09-01-flux");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "03-implement.md"), "# implement\nwired the flux capacitor");
    run(["mission", "ingest", "--repo", repo, "--dir", ".troopers/2026-09-01-flux"]);
    const d = await startDash();
    try {
      const p = await (await fetch(`${d.base}/api/project/${project.id}`)).json();
      expect(p.missions).toHaveLength(1);
      expect(p.missions[0].slug).toBe("flux");
      expect(p.missions[0].stage_plan).toEqual(["implement", "gate", "verify"]);
      expect(p.missions[0].stage_cursor).toBe(1);
      expect(p.missions[0].task_title).toBe("Wire flux");
      expect(p.missions[0].handoffs).toHaveLength(1);
      expect(p.missions[0].handoffs[0].content).toContain("built");
      expect(p.missions[0].artifacts).toHaveLength(1);
      expect(p.missions[0].artifacts[0].filename).toBe("03-implement.md");
      expect(p.missions[0].artifacts[0].bytes).toBeGreaterThan(0);
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
      // theme.js must be a servable file (CSP forbids inline scripts) and
      // must run before first paint, so index.html references it in <head>.
      const theme = await fetch(`${d.base}/theme.js`);
      expect(theme.headers.get("content-type")).toContain("text/javascript");
      expect(await theme.text()).toContain("anakin-theme");
    } finally { d.stop(); }
  });
});

describe("dashboard views", () => {
  test("built app contains all view renderers and the diff viewer", async () => {
    seed();
    const d = await startDash();
    try {
      const js = await (await fetch(`${d.base}/app.js`)).text();
      for (const fn of ["renderProject", "renderMissions", "renderJournal", "renderKnowledge", "renderGate", "renderDiff"])
        expect(js).toContain(fn);
    } finally { d.stop(); }
  });
});

describe("snapshot", () => {
  function runDash(args: string[]) {
    const p = Bun.spawnSync(["bun", DASH, ...args], {
      env: { ...process.env, ANAKIN_HOME: home }, stdout: "pipe", stderr: "pipe",
      timeout: 5000,
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
    // theme init must be inlined — a snapshot file has no server to fetch from
    expect(html).toContain("anakin-theme");
    expect(html).not.toContain('src="/theme.js"');
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

describe("review fixes", () => {
  test("version seq moves for prefs, gate, knowledge body, and new projects", async () => {
    const { repo } = seed();
    const d = await startDash();
    try {
      const get = async () => (await (await fetch(`${d.base}/api/version`)).json()).seq;
      const v0 = await get();
      run(["prefs", "set", "--key", "tone"], "direct");
      const v1 = await get();
      expect(v1).not.toBe(v0);
      run(["gate", "set", "--repo", repo], JSON.stringify([{ command: "make check", reason: "" }]));
      const v2 = await get();
      expect(v2).not.toBe(v1);
      run(["knowledge", "set", "--repo", repo],
        JSON.stringify({ kind: "boundary", title: "no-infra", body: "UPDATED BODY, different length", paths_glob: "src/**" }));
      const v3 = await get();
      expect(v3).not.toBe(v2);
      const repo2 = makeRepo();
      run(["init", "--repo", repo2]);
      const v4 = await get();
      expect(v4).not.toBe(v3);
      // a status flip landing in the same second as the prior write still
      // moves the seq — the digest reads content, not just count+timestamp
      run(["task", "close", "--repo", repo, "--id", "1"]);
      const v5 = await get();
      expect(v5).not.toBe(v4);
    } finally { d.stop(); }
  });

  test("non-loopback Host header is refused", async () => {
    seed();
    const d = await startDash();
    try {
      const r = await fetch(`${d.base}/api/overview`, { headers: { host: "evil.example.com" } });
      expect(r.status).toBe(403);
      expect((await fetch(`${d.base}/api/overview`, { headers: { host: `localhost:${d.port}` } })).status).toBe(200);
    } finally { d.stop(); }
  });

  test("unopenable DB yields 500 JSON, not an HTML error page", async () => {
    const d = await startDash();
    try {
      mkdirSync(join(home, "anakin.db")); // a directory named like the DB → open throws
      const r = await fetch(`${d.base}/api/overview`);
      expect(r.status).toBe(500);
      expect(r.headers.get("content-type")).toContain("application/json");
      expect((await r.json()).error).toBeTruthy();
    } finally { d.stop(); rmSync(join(home, "anakin.db"), { recursive: true, force: true }); }
  });

  test("task-less and committed-task questions never count as waiting", async () => {
    const { repo, task } = seed();
    // a task-less stop question — nothing could ever clear it
    run(["journal", "append", "--repo", repo],
      JSON.stringify({ entry_kind: "stop", decisions: "orphan", questions: "am I forever?" }));
    const d = await startDash();
    try {
      const o = await (await fetch(`${d.base}/api/overview`)).json();
      expect(o.totals.open_questions).toBe(1); // only the active task's question
      expect(o.questions).toHaveLength(1);
      expect(o.questions[0].task_title).toBe("Wire flux");
    } finally { d.stop(); }
  });

  test("FTS search is scoped to the viewed project", async () => {
    const { project, repo } = seed();
    // second project journals the same distinctive term
    const repo2 = makeRepo();
    const p2 = run(["init", "--repo", repo2]).json();
    run(["journal", "append", "--repo", repo2],
      JSON.stringify({ entry_kind: "note", decisions: "webhooks flaked here too" }));
    const d = await startDash();
    try {
      const a = await (await fetch(`${d.base}/api/journal/${project.id}?q=webhooks`)).json();
      expect(a.entries).toHaveLength(1);
      expect(a.entries[0].decisions).toContain("polling");
      const b = await (await fetch(`${d.base}/api/journal/${p2.id}?q=webhooks`)).json();
      expect(b.entries).toHaveLength(1);
      expect(b.entries[0].decisions).toContain("here too");
    } finally { d.stop(); }
  });
});
