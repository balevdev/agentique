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
