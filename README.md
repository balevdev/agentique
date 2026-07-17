# agentique

Opinionated software factories for agents, free and in the open. Two skills:

- **`anakin`** — the current factory. Minimal and knowledge-first: it learns the repo's real
  architecture into plain markdown, gates every tick on the repo's own toolchain, builds in the
  main context (subagents only read), and ships one verified diff per tick. ~2.7k instruction
  tokens per tick, zero bespoke engine code. Start here.
- **`vader`** — the predecessor, parked. A compiled-constitution factory with fingerprint locks,
  worktree fan-out, and refute-first voter panels. It works, but costs ~20 subagent dispatches
  and ~13k instruction tokens per tick; anakin keeps its load-bearing ideas (deterministic gate
  before any LLM review, rehydrate don't re-derive, one item one diff) and deletes the rest.
  Kept for reference until anakin has fully replaced it; see the design doc in
  `docs/specs/2026-07-17-anakin-design.md` for the full comparison.

The name is *agent* plus *etiquette*: an agent that says *bonjour* before it `sudo`s, asks
*pardon* before it pushes, and never finishes a sentence with an em dash.

Distributed through the open [skills.sh](https://skills.sh) ecosystem.

## Install

```bash
npx skills add balevdev/agentique
```

Pass `-g` for a global install, or `-a claude-code` (etc.) to target one agent. See
`npx skills add --help` for the full set.

## What anakin is

One approved spec becomes shipped code through small, verified, journaled diffs. One tick = one
roadmap item = one reviewable commit; between ticks the context is discarded and the committed
`.anakin/` markdown files (`KNOWLEDGE.md`, `GATE.md`, `SPEC.md`, `ROADMAP.md`, `JOURNAL.md`)
are the only memory.

The operating principles: context is finite (a tick reads a bounded packet); knowledge is
obtained from the repo, not imposed as invariants (boundaries worth enforcing get mechanized
into lint rules, fallow config, or real tests — tools someone else maintains); determinism
beats discipline (the repo's own typecheck/lint/tests/fallow are the gate, and a red gate
spawns zero reviewers); the main context builds (no relay chains); ask before spec, never
mid-tick (one mandatory human gate at spec approval, clean journaled stops everywhere else).

Run it with `/anakin` driven by `/loop`. See `skills/anakin/SKILL.md`.

## What vader is (parked)

An agent loop is a box with no memory of what it meant. Vader puts the meaning *outside* the
box. A human authors a `constitution.model` that names the semantic distinctions which must
never collapse (a temporal point is not a temporal interval; `common` must not import `etl`) as
four invariant kinds: `shape`, `dependency`, `data`, and `behavioral`, plus a `rawCheck`
escape. A router (`vader gen`) compiles each one into the strongest deterministic check the
target toolchain allows: TypeScript gets real compile errors from branded types and
`@ts-expect-error`, every other language gets a generated property test or AST scan floor. When
an agent collapses a distinction, `vader gate` fails on a named invariant id, which is an
automatic verifier bounce. No judgment, no drift.

It is built for people who prefer encapsulated, simple code: deep modules behind thin
interfaces, encapsulation over abstraction, one pattern per concern, no premature DRY, low
cognitive load. Those values are not a style guide here; they are enforced by the gate and
carried in every owner and verifier prompt.

### The loop

Vader runs on two human gates and nothing else: freeze the model at conceive, and approve any
later model change. Between them the build is autonomous (gate the model, free the code). An
anti-decay lock makes the model a protected artifact: owners can make code fail the gate but
cannot edit `constitution.model.*` or `generated/` to silence it, and the gate fails closed if
the locked model hash no longer matches. A run may *propose* a model change; it never applies
one.

Two modes share one engine:

- **build**: idea to shipped code. Conceive (human gate), decompose into disjoint slices, then
  per tick implement one roadmap item and verify it.
- **review**: audit and harden an existing repo. Ground a fresh baseline, partition the repo
  into disjoint slices, then per tick implement and verify a slice batch.

Both share the same spine: disjoint slices, frozen contracts, refute-first verifiers who never
bless their own work, the compiled-constitution gate, and a triage-gated persist that refuses
to end a tick while any open risk is untriaged. Between ticks a small deterministic CLI
(`scripts/vader.ts`, bun, zero runtime deps) closes the loop: `recall` rehydrates a session
from hash-stamped factory state in one call, the ledger turns verifier bounces into calibration
data that pre-empts owners and scales verification next tick, and an evidence-derived ratchet
computes how much human gating each slice class still needs, with automatic demotion on any
defect. Factory state lives in a committed `.vader/` directory, so any future session, machine,
or human inherits the partition, decisions, conventions, open risks, and defect history.

### One spine, a thin edge per harness

The deep module is the spine: the `vader` CLI plus the protocol and the acceptance gate. None
of it knows which agent host drives it. An adapter is the thin interface that lets a given host
run a tick, and `planTick(recall)` is the single source of truth for the fan-out, so the plan
cannot drift between harnesses.

| Harness | Fan-out primitive | Status |
|---|---|---|
| Claude Code | the `Workflow` tool (agent / parallel / pipeline) | working |
| Pi | `extensions/vader` plus pi-subagents | implemented (extension, unit-tested) |
| Codex / Hermes | native subagents, else sequential | shared `planTick` plus sequential fallback |

A host with no fan-out primitive runs the exact same `planTick` output one agent at a time; the
assembled run report and the gate verdict are byte-identical to the parallel path. See
`skills/vader/references/adapters.md`.

## The Pi extension

`extensions/vader` is a Pi companion that registers `/vader`, `/vader-preview`, `/vader-status`,
and `/vader-clear`. It does not edit code or spawn subagents directly; it builds a structured
kickoff prompt so the parent Pi agent stays the orchestrator.

To install manually into Pi:

```bash
mkdir -p ~/.pi/agent/extensions/vader
cp extensions/vader/index.ts ~/.pi/agent/extensions/vader/index.ts
/reload
```

Then run:

```text
/vader review apps/api --concurrency 4 --worktree single-tree
```

## Repo layout

```
agentique/
├── skills/
│   ├── anakin/
│   │   ├── SKILL.md                 # principles, state files, phase routing, stop conditions
│   │   ├── commands/
│   │   │   └── anakin.md            # /anakin: one step per firing, pacing, arguments
│   │   └── references/
│   │       ├── knowledge.md         # init: discover GATE.md, learn KNOWLEDGE.md, mechanize boundaries
│   │       ├── conceive.md          # interview-first spec flow, the one human gate
│   │       ├── decompose.md         # spec → one-tick roadmap items, sizing and ordering
│   │       └── tick.md              # recall → verify map → build → gate → review → persist
│   └── vader/                       # parked: SKILL.md, commands/, references/, scripts/ (CLI + tests)
└── extensions/
    └── vader/
        ├── index.ts                 # Pi companion slash commands and TUI wizard
        └── extension.test.ts        # behavior tests for prompt/status state
```

The skills.sh CLI auto-discovers any directory under `skills/` that contains a `SKILL.md` with
a `name` and `description` in its YAML frontmatter.

## License

MIT. See [LICENSE](LICENSE).
