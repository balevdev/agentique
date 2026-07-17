# Init: obtain the repo's knowledge

Goal: after init, any fresh context can act like an engineer who already knows
this repo — by reading two files. Everything here is learned from the code, never
invented.

## 1. Discover the gate → `GATE.md`

Find the commands that already define "correct" for this repo: typecheck, lint,
test, build — from package.json scripts, Makefile, CI config, whatever the repo
actually uses. If `fallow` is on PATH and the repo has (or can trivially take) a
`.fallowrc`, include `fallow audit --gate new-only` as a structural step.

Write `GATE.md` as a short list of exact shell commands with a one-line reason
each. Then run the whole gate once. It must be green before any factory work: if
the baseline is red, report the failures and stop — a factory cannot verify diffs
against a broken baseline, and fixing it is the human's call (they may make it the
first roadmap item).

## 2. Map the architecture → `KNOWLEDGE.md`

Prefer `repomap` when available (`repomap index`, then `repomap ask` /
`repomap graph` for structure and dependencies). Otherwise dispatch read-only
Explore scouts. Either way, you are extracting facts, and every claim should be
checkable against a file path.

Structure the file with these sections, each ending with `verified: <short-sha>`
of the commit it was checked against:

- **Layout** — top-level modules/packages and what each owns, one line each.
- **Boundaries** — dependency rules the code actually observes ("domain/ never
  imports infra/", "all DB access goes through repositories/"). Only rules the
  code follows today or the human states; note violations honestly instead of
  papering over them.
- **Conventions** — naming, error handling, test placement, patterns a new
  change is expected to follow. Derived from the dominant pattern in the code.
- **Sensitive zones** — paths where a defect is expensive: auth, money,
  migrations, public API contracts, data deletion. This list is what later
  triggers an independent review on a tick (see tick.md). Be specific: paths,
  not vibes.
- **Gotchas** — the non-obvious traps a newcomer would hit. Only real ones.

Keep the whole file readable in one sitting (~150 lines). It is a map, not a
wiki: link to files rather than restating their contents.

## 3. Mechanize what deserves it

For each Boundary that matters and is cheap to enforce, add an unchecked
hardening item to `ROADMAP.md` (create the file if absent) proposing the
mechanization: an eslint `no-restricted-imports` rule, a fallow boundary, a
failing test. The principle: a boundary lives in a tool someone else maintains,
or it lives in KNOWLEDGE.md prose — never in a bespoke engine. The human approves
these items like any others.

## Maintaining KNOWLEDGE.md (every phase, forever)

- Before relying on a section whose `verified:` commit is far behind HEAD in the
  area you're touching, re-check it (repomap or a quick read) and re-stamp.
- When a tick teaches you something a newcomer would need, add it — smallest
  edit that captures the fact.
- When reality contradicts the map, the map is wrong: fix it in the same tick
  and say so in the journal. A confident stale map is worse than no map.
