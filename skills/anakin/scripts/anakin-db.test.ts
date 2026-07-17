import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, readdirSync } from "node:fs";
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
    const t = run(["task", "new", "--repo", repo], JSON.stringify({ title: "T" })).json();
    run(["task", "approve", "--repo", repo, "--id", String(t.id)]);
    const it = run(["item", "add", "--repo", repo, "--task", String(t.id)],
      JSON.stringify({ ordinal: 1, title: "flux capacitor wiring", files: "src/flux.ts", done_when: "green" })).json();
    return { t, it, sha };
  }

  test("packet: task, next item, scoped knowledge (globs + all boundaries), prefs, FTS hits", () => {
    const repo = makeRepo();
    const { t, it } = seed(repo);
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
