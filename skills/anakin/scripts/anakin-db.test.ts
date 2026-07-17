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
