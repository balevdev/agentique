# ANAKIN — a minimal, fast, knowledge-first software factory skill

## Context

Vader (the current factory in `~/projects/agentique`) works but is slow, token-heavy, and structurally prone to information loss:

- **~13k tokens** of instruction markdown loaded per tick across 7 overlapping reference files (~40% redundant).
- **~20+ subagent dispatches per tick** (critic + slice owners in worktrees + refute-first voter panels), with the verifier prompt re-injected verbatim into every judge.
- Information passes through hand-assembled JSON schemas and a manually built RunReport — the relay chain is where wrong information leaks in.
- A 609-line `memory.ts` serves a voter/ratchet/debt apparatus calibrated on 14 runs; vader's own docs call it "a heuristic, not a measurement."
- The bespoke constitution compiler (the most expensive part) under-delivers: the shape compiler is hardcoded to one example, and the style values that make code good are carried by prompts anyway.

ANAKIN replaces it with a factory built on context-engineering first principles: **knowledge is obtained from the repo, not imposed as invariants; the deterministic gate is the repo's own toolchain; the main context builds; subagents only read; state is plain markdown.**

Decisions made with the user during brainstorm:
1. **Drop the bespoke engine entirely** — gate = typecheck + lint + tests + fallow (new-only). Architectural boundaries that matter get mechanized into lint rules / fallow config / real tests, not a custom compiler.
2. **Main context implements**; subagents are read-only (exploration/research) plus at most one risk-triggered reviewer. `/loop` gives a fresh context per tick, so tick boundaries — not subagent relays — solve context rot.
3. **Local `/loop` runtime** like vader (cloud/GH-Actions triggers can bolt on later; a skill is trigger-agnostic).
4. **ANAKIN lives in `agentique` as `skills/anakin/`; vader stays parked untouched** until ANAKIN proves itself, then gets deleted.
5. **One loop, two seeds**: roadmap items can be features (seeded from a spec) or hardening tasks (seeded from fallow/audit findings). No separate build/review mode machinery.
6. **Review policy**: deterministic gate → diff self-review every tick → one fresh-context refute-first reviewer subagent ONLY when the item touches a zone KNOWLEDGE.md marks sensitive. Zero voter panels.

## What ANAKIN keeps from vader (the ~15% that earned its place)

- Deterministic gate **before** any LLM judgment; red gate spawns zero reviewers.
- One tick per `/loop` firing, self-paced with `ScheduleWakeup`.
- Rehydrate-don't-re-derive: a bounded recall read at tick start.
- Human gate on the spec; stop-and-ask on ambiguity.
- Committed factory state so any session/machine/human inherits it.
- One item → one reviewable diff.

## What ANAKIN throws away

| Vader piece | ANAKIN replacement |
|---|---|
| Constitution compiler + gen/gate/persist CLI (~1,800 lines TS) | Repo's own toolchain, recorded in `GATE.md` |
| Fingerprint/enforcement hashes | Nothing bespoke to tamper with; gate commands are repo code, protected by review like all code |
| Critic subagent | Inline sanity check during decompose |
| Parallel owners in worktrees + merge | Main-context sequential build |
| Refute-first voter panels (1–3 per slice) | Self-review + risk-triggered single reviewer |
| Autonomy/debt ratchets, bounce calibration | JOURNAL.md history read by the human |
| 4-harness adapter matrix + Pi extension | None; plain skill markdown is portable by nature |
| 7 reference files, ~13k tokens | 2-level md, phase-scoped loading, ~3–4k tokens per tick |

## The design

### File structure (the skill — strict 2 levels)

```
skills/anakin/
  SKILL.md                 ≤150 lines: philosophy, the loop, file contracts, stop conditions
  commands/anakin.md       ~40 lines: /anakin = exactly one tick per firing + pacing
  references/
    conceive.md            interview-first spec flow → SPEC.md → human gate
    decompose.md           spec/audit findings → ROADMAP.md; item-sizing rules (one tick, one diff)
    tick.md                the build-tick recipe (the only reference loaded on a normal tick)
    knowledge.md           how to build and maintain KNOWLEDGE.md (repomap-first, verify-stamps)
```

Context-engineering rule encoded in SKILL.md: **a tick loads SKILL.md + tick.md + state files and nothing else.** conceive.md / decompose.md / knowledge.md load only during their phase. Per-tick instruction load ≈ 3–4k tokens vs vader's 13k+.

### Project state (`.anakin/`, committed, plain markdown)

```
.anakin/
  KNOWLEDGE.md   architecture map OBTAINED from the repo: modules, boundaries,
                 conventions, sensitive zones (auth/money/migrations/public contracts),
                 gotchas. Each section stamped `verified: <commit>`.
  SPEC.md        human-approved spec (human gate #1)
  ROADMAP.md     checkbox list; each item sized for one tick; features and
                 hardening tasks intermixed
  JOURNAL.md     append-only tick log: item, gate result, decisions, open
                 questions/risks. Ticks read only the last ~5 entries.
  GATE.md        the exact shell commands that ARE the gate for this repo
                 (typecheck, lint, test, fallow audit --gate new-only),
                 discovered once at init
```

### The three flows

**Init / knowledge acquisition** (`/anakin` in a repo with no `.anakin/`):
1. Discover the toolchain → write `GATE.md`; run it once to confirm green baseline.
2. Build `KNOWLEDGE.md` via repomap when available (`repomap index` + `ask`/`graph`), Explore subagents otherwise. Record boundaries, conventions, sensitive zones — learned from the code, not invented.
3. Where a discovered boundary can be mechanized cheaply (eslint `no-restricted-imports`, fallow boundary, a failing test), add a hardening item to ROADMAP.md proposing it. **Boundaries live in tools someone else maintains, or in KNOWLEDGE.md prose — never in a bespoke engine.**

**Conceive** (idea → spec, human gate):
1. Interview before spec — ask the questions vader never asked: purpose, constraints, success criteria, non-goals, sensitive zones touched. One at a time, multiple-choice preferred.
2. Write SPEC.md; decompose into ROADMAP.md items (each: one tick, one concern, one reviewable diff; sanity-check items are disjoint inline — no critic agent).
3. STOP for human approval of SPEC.md + ROADMAP.md. This is the only mandatory human gate.

**Tick** (each `/loop` firing, fresh context):
1. **Recall**: read GATE.md, ROADMAP.md (next unchecked item), KNOWLEDGE.md, JOURNAL.md tail.
2. **Staleness**: if the item's area has a `verified:` stamp far behind HEAD, re-verify that section (repomap/quick read) and update KNOWLEDGE.md first.
3. **Build in main context.** Explore subagent only to scout an unmapped area; its report feeds the build, never a schema relay.
4. **Gate**: run GATE.md. Red → fix; after 3 failed attempts, journal the block with the exact failure and stop for the human.
5. **Self-review**: re-read the full diff against the roadmap item and KNOWLEDGE.md conventions.
6. **Risk review**: only if the item touches a KNOWLEDGE.md sensitive zone → one fresh-context refute-first reviewer subagent; findings fixed or journaled.
7. **Persist**: check the item off, append a JOURNAL entry (item, gate verdict, decisions, open questions), update KNOWLEDGE.md if something was learned, commit with a conventional message.
8. **Pace**: `ScheduleWakeup` for the next tick. Stop (instead of scheduling) when: roadmap exhausted, blocked on gate, or an ambiguity/scope question needs the human — questions are journaled and surfaced in the final message.

### Autonomy contract

Two human touchpoints only: approve the spec/roadmap; answer journaled questions when ANAKIN stops itself. Everything between is autonomous. Proactivity rule: **ask before spec'ing, never ask during a tick** — mid-tick ambiguity becomes a journaled question and a clean stop, not a stall.

## Files to create/modify

- `skills/anakin/SKILL.md` (new)
- `skills/anakin/commands/anakin.md` (new)
- `skills/anakin/references/{conceive,decompose,tick,knowledge}.md` (new)
- `README.md` in agentique — add ANAKIN section, mark vader as parked/legacy (small edit)
- `docs/specs/2026-07-17-anakin-design.md` — this design, committed per brainstorming convention
- **Not touched**: everything under `skills/vader/`, `extensions/vader/` (parked)

## Writing constraints for the skill files (self-applied KISS)

- SKILL.md ≤150 lines; each reference ≤120 lines; command ≤50 lines.
- A concept is explained in exactly one file; others link to it. (Vader's 40% redundancy came from re-explaining.)
- No harness matrix, no fallback scripts, no pseudo-code orchestration blocks — prose instructions to a capable agent.

## Verification

1. **Token audit**: count words/chars of the finished skill; per-tick load (SKILL.md + tick.md + command) must stay under ~4k tokens.
2. **Dogfood run**: init ANAKIN on a small real repo (or a toy repo), run conceive on a modest feature, let `/loop /anakin` execute 3–5 ticks. Confirm: gate runs before any review, journal entries append, a deliberately ambiguous roadmap item produces a clean stop with a journaled question.
3. **Comparison note**: record ticks/wall-clock/subagent-count for the dogfood run vs vader's known ~20+ dispatches, written into `docs/`.

## Risks / assumptions

- **No fingerprint lock**: an agent could edit GATE.md to weaken the gate. Mitigation: GATE.md is committed code reviewed like any diff, and tick.md forbids editing it mid-tick (instruction, not enforcement). If this proves insufficient in practice, a 5-line pre-commit hash check can be added later — start without it (KISS).
- **KNOWLEDGE.md drift**: mitigated by `verified:` stamps + staleness step, but a stale map can mislead a tick. Journal makes it auditable.
- Assumes `fallow` and `repomap` availability is optional — the skill degrades gracefully (gate without fallow, exploration without repomap).
