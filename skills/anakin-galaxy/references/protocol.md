# Protocol: one factory run, phases -1 to 5

A run is one sprint through the loop. The session (the main Claude Code loop) does
everything that needs judgment, approval, or full-repo shell. The Workflow tool does the
deterministic fan-out. The galaxy CLI does the deterministic memory. Do not move work
across those lines without reason.

| Phase | Runs in | What happens |
|-------|---------|--------------|
| -1 Recall | session + CLI | `galaxy recall`; verify-before-trust on stale flags |
| 0 Ground | session | refresh only invalidated layers; run a FRESH baseline |
| 1 Compile | session | triage risks; spec to design to slices to frozen contracts; human approves |
| 2 Fan out | Workflow | seam owner first, then parallel owners |
| 3 Verify | Workflow | cross-assigned refute-first verifiers, voters scaled by evidence |
| 4 Gate | session | full suite, two-sided baseline check, route regressions |
| 5 Persist | session + CLI | assemble run-report.json; `galaxy persist` |

## The one invariant

Every slice has exactly one owner, and no owner writes another slice's paths. Outside its
slice an agent has read-only access. An owner writes no code until its contract is
approved, and the contract freezes only the seam and the acceptance surface, never the
internals. Disjointness is guaranteed by the slicing, not by the runtime. Nobody verifies
their own work.

A **seam** is any surface more than one slice depends on: a shared type, a schema, an API
contract, a helper consumed across slices. During slicing, assign every seam to exactly
one owner (the seam owner) and sequence that owner first, alone, so siblings build
against a stable surface. Other owners touch a consumed seam only by escalating in their
report, never by editing it. Seam changes are a never-ratchet class.

## The engineering mantra (priority order)

Applies to the code agents write, the workflow script, and the CLI itself.

1. Deep modules, thin interfaces. Hide complexity behind a small surface.
2. Encapsulation over abstraction. A clear concrete pattern beats a clever generic one.
   No shiny abstractions, no premature DRY, no over-split files, no deep nesting.
3. Code locality, low cognitive load. A junior reads it top to bottom.
4. One pattern per concern across the repo. Predictable beats novel.
5. Clear data models and structure are the backbone. Each piece owns the right amount.
6. Simple, readable, predictable output. Functional-first TypeScript, strict, no `any`,
   no unsafe casts. No em dashes and no en dashes anywhere.

If correctness or a contract would force a violation, log a residual risk and escalate.

## Phase -1: Recall

If `.galaxy/` does not exist yet, run `galaxy init` once (idempotent; recall on an
uninitialized repo errors and names the fix). Then run `galaxy recall` and read the
packet (exact shape in `memory.md`). It tells you:

- `grounding.stale` / `partition.stale`: which stable layers need refreshing and why
  (`no-stamp`, `missing-commit`, or `watch-touched` with the changed files named).
- `mustTriage`: every open risk. Each one MUST get a disposition this run (Phase 1);
  persist will refuse otherwise.
- `topBounces`: recurring verifier bounce patterns by slice class. Inject the relevant
  ones into owner preambles (Phase 2) and use them to scale verifier voters (Phase 3).
- `ratchet`: per-class autonomy verdicts with evidence.
- `decisions` / `conventions`: pointers to the prose files. Read DECISIONS.md before any
  design work; read CONVENTIONS.md before writing owner preambles.

Verify before trust: a recorded decision, partition, or convention that conflicts with
current code is surfaced and re-triaged, never silently applied.

## Phase 0: Ground

Refresh ONLY what recall flagged stale. The stable layer of `.galaxy/GROUNDING.md`
(glossary, module graph, seams, conventions) is cached and stamped; rewrite only the
invalidated sections. Then run the real baseline fresh: build, typecheck, lint, test
counts on the untouched repo. Baselines are NEVER cached or persisted; a stale baseline
silently blames the team for pre-existing red or excuses a real regression.

## Phase 1: Compile

First triage: every risk in `mustTriage` becomes a contract finding (`finding`: it is now
in scope and the risk closes), an explicit re-deferral with a reason (`defer`), or a
closure (`close`). Use `galaxy triage` or carry dispositions in the run report.

Then compile the spec: design (build mode) with a critic that reads DECISIONS.md and must
flag any contradiction as revise or an explicit supersession; slices against the proven
partition when recall says it is still valid, re-slicing only the stale region; frozen
contracts whose every acceptance criterion is a test or observable check. A contract may
declare `risk: high` (subtle correctness, concurrency, money, auth); that flag drives
verifier voter count in Phase 3. Write all of it under `.galaxy/runs/<run-id>/`
(SPEC.md, DESIGN.md, SLICES.md, contracts/). The run id is `<YYYY-MM-DD>-<kebab-slug>`,
chosen by the session; persist enforces uniqueness against the ledger.

The human approves the contract diff before any code is written. This is the highest
leverage human surface in the factory: contracts define the checked surface, and the
checked surface is where slop is excluded.

## Phase 2 and 3: Fan out and verify (Workflow)

The session authors ONE workflow script and launches it. See `recipes.md` for the
idioms. Shape: design critic, then the seam owner alone, then sibling owners in
parallel, then cross-assigned verifiers. Owners obey context discipline (read only what
the contract names, escalate rather than expand scope), verify slice-scoped only, never
commit, and write `reports/<slice>.report.json` in the run dir in addition to returning
the schema object. Verifier stance: assume each AC is NOT met and try to refute it;
hollow checks and code-free claims are bounces; default to bounce when uncertain.

Memory feeds both phases: owner preambles carry the class's top bounce reasons from
recall (pre-emption), and verifier voter count scales with the class's bounce history
(spend verification where measured risk lives, not by vibes).

## Phase 4: Gate

Back in the session: resolve escalations (apply each seam change once, in the owner
slice), run the full repo suite once, apply the two-sided check against the fresh
baseline (nothing green at baseline may regress, and the run's acceptance criteria must
now pass). Route each regression to its owning slice for a bounded fix and re-verify,
looping until green or the residual is logged as a risk. Write SUMMARY.md in the run dir.

## Phase 5: Persist

Assemble `run-report.json` (schema in `memory.md`) from the gate result, the verifier
verdicts, the bounces, new and dispositioned risks, decisions that survived the gate,
and any convention freezes. Include `stamps` ONLY for layers you actually refreshed this
run. Then:

```
galaxy persist .galaxy/runs/<run-id>/run-report.json
```

If it exits 1, fix what it names (usually an untriaged risk) and run it again. A run that
did not persist is a failed run, full stop. Then commit the run's code diff and the
`.galaxy/` diff together, one commit on the working branch, so the factory state always
travels with the code it describes.

## Without the Workflow tool

The protocol does not change, only the executor: hand-spawn owners and verifiers with the
Agent tool in the same order (seam first, siblings parallel, verifiers cross-assigned),
or fall back to a single-agent sequential pass on minimal hosts. Phases -1, 0, 1, 4, 5
are identical.
