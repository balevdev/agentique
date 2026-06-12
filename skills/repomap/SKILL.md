---
name: repomap
description: "Index, search, and graph-traverse multi-repo workspaces with the repomap CLI/MCP tool so every claim about code comes with a repo/file:line citation. Use this whenever work spans more than one repository in a folder: finding where a symbol, table, endpoint, env var, or package is defined or used; impact analysis before a change (who imports this file, who calls this function, who reads or writes this table); orienting in an unfamiliar workspace or microservice fleet; or any moment you are about to grep, glob, or read files across repos to answer a question. Also use it when a folder contains a .repomap directory, when the user mentions repomap, a code index, a call graph, a knowledge graph of their repos, or cross-repo or cross-service research, or when long flows are burning tokens on repeated file reading."
---

# repomap: cited cross-repo retrieval

repomap is a local-first index of every git repo under one folder: full text search
(SQLite FTS5), extracted symbols (functions, classes, tables, endpoints, collections),
declared packages, and a code graph (imports, table reads/writes, definitions,
dependencies). Every answer carries `repo/file:line` citations. No server, no API keys,
no runtime dependencies; one `.repomap/` directory holds everything and can always be
rebuilt from source.

Why it matters to you as an agent: grepping 100 repos costs tokens and misses context;
answering from memory invents code that does not exist. repomap gives you exact,
citable facts in one cheap call. Treat it as your retrieval layer: query first, then
Read only the files the citations point to, and never assert a cross-repo fact you
cannot cite.

## Setup

```bash
npm install -g repo-map     # package is repo-map, the command is repomap
cd ~/work                   # any folder containing git repos
repomap init && repomap index
```

Requires Node 22.13+ (built-in node:sqlite, nothing to compile). Every command works
from any subdirectory; repomap walks upward to find `.repomap` the way git finds `.git`.

## First: is this a repomap workspace?

One cheap check decides everything: does a `.repomap/` directory exist at or above the
working directory? If yes, use repomap as your retrieval layer for the rest of the
session. If no, and the folder holds several git repos, offer `repomap init` to the
user once (it only writes a local `.repomap/` folder); do not initialize or install
anything uninvited, and fall back to your normal tools without ceremony. The skill
should never cost you time in workspaces where repomap does not apply.

## The session habit

At the start of any session in a repomap workspace, run:

```bash
repomap index
```

It rehashes every file (sha1) and skips unchanged ones, so it is a fast no-op when
nothing changed and it guarantees the index matches the working tree. Source files are
always the truth; the index is derived data. If results ever look wrong, `repomap index
--force` rebuilds everything.

Know the cost shape so you spend wisely: `ask` and `graph` are milliseconds, `index` is
about a second per few thousand files, `--force` and the first `--deep` run rebuild a
lot. Do not run `--deep` as a session habit; reach for it the first time a task
actually needs call chains.

## Choosing the right tool

| You want | Run |
| --- | --- |
| Find a symbol, phrase, env var, package | `repomap ask "DATABASE_URL" --json` |
| Search one repo only | `repomap ask "licence" --repo my-api --json` |
| Who depends on this file (blast radius) | `repomap graph "file:my-api/src/auth.ts" --direction in --depth 2 --json` |
| Who calls this function (needs deep mode) | `repomap graph "function:my-api/src/auth.ts#validate" --direction in --json` |
| Who extends or implements a type (deep) | `repomap graph "type:my-api/src/users.ts#User" --direction in --json` |
| Who defines, reads, writes a table | `repomap graph "table:users" --direction in --json` |
| Every importer of a package or module | `repomap graph "module:dataloader" --direction in --json` |
| What a file imports or defines | `repomap graph "file:my-api/src/server.ts" --direction out --json` |
| Orient in an unfamiliar repo | read `.repomap/exports/wiki/<repo>.md` (rebuild with `repomap wiki`) |
| Does an index even exist, how big | `repomap status --json` |
| Whole graph for external tooling | `repomap graph --export` writes `.repomap/exports/graph.json` |

Graph node keys are plain strings; exact key matches win, substrings work as fallback:

```text
file:<repo>/<path>   table:<name>   endpoint:<VERB /path>   collection:<slug>
package:<ecosystem>:<name>   module:<import specifier>   repo:<path>
function:<repo>/<path>#<name>   type:<repo>/<path>#<name>   (deep mode)
```

`--direction in` answers "who uses this" (impact analysis). `--direction out` answers
"what does this use". Depth runs 1 to 4; start at 1 and widen only if you need the
transitive picture. A substring like `"#validateLicence"` matches function and type
nodes without spelling out the full key.

## Deep mode: the TS/JS call graph

```bash
repomap index --deep
```

Deep mode parses TypeScript and JavaScript with the TypeScript compiler API and adds
edges regex cannot see: file defines `function:`/`type:` nodes, file `calls` imported
functions, and classes `extends`/`implements` types. That turns "who calls this
function" and "who implements this interface" into one graph query instead of a grep
plus guesswork.

It is opt-in and conservative: only named and namespace imports from relative paths
that resolve to a real file produce call edges, so every edge is provably true. It
needs the `typescript` package (in the indexed repo or globally); without it the
command fails loud with install instructions. Run it once per workspace: later plain
`repomap index` runs keep the deep edges for unchanged files at no extra cost. Use it
when the task involves call chains, refactoring shared functions, or interface
contracts across services; plain indexing already covers search and import graphs.

## MCP integration

If the harness supports MCP, register the server once and the same capabilities appear
as tools (`repomap_ask`, `repomap_graph`, `repomap_status`, `repomap_index`,
`repomap_wiki`):

```bash
claude mcp add repomap -- repomap mcp --root /path/to/workspace
```

or in any MCP client config:

```json
{ "mcpServers": { "repomap": { "command": "repomap", "args": ["mcp", "--root", "/path/to/workspace"] } } }
```

Prefer MCP tools when present; fall back to the CLI with `--json` otherwise. Both hit
the same SQLite index.

## Working rules

1. Query repomap before grepping or globbing across repos. One `ask` call replaces a
   fan-out of file reads.
2. Cite what you claim. Every hit comes with `repo/file:line`; carry those citations
   into your answer so the user (or the next agent) can verify.
3. Verify before editing. Citations tell you where to look; Read the actual file before
   changing it. The index is for finding, not for editing blind.
4. Use `graph --direction in` before modifying anything shared (a table, a heavily
   imported file, an endpoint, a deep-indexed function). Knowing the blast radius beats
   discovering it in review.
5. Trust the freshness signals. Wiki pages flag repos as STALE (commits landed after
   the last index) or dirty (uncommitted edits); `repomap index` resolves both.
6. Empty results are information, not a dead end. Reindex once, broaden the terms, and
   if repomap still finds nothing, fall back to grep in the most likely repo. repomap
   narrows where you look; it never forbids looking.

## Knowing the limits

Extraction is regex based by design (cheap, deterministic, no per-language plugins), so
expect occasional noise nodes such as a `table:` entry harvested from prose that
resembled SQL. Citations make noise trivially dismissable: check the cited line. Symbol
coverage spans TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, Ruby, PHP, C#,
SQL, Prisma, and GraphQL; import edges resolve for TypeScript, JavaScript, Python, and
Go. Deep mode covers TypeScript and JavaScript only, and skips default imports and
package imports on purpose: an absent call edge means "not provable", not "not called".
If a query returns nothing, reindex first (with `--deep` for function and type nodes),
then try broader or fewer terms; multi word queries fall back from AND to OR
automatically.
