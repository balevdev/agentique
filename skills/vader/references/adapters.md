# Vader harness adapters

Vader is one deep module with a thin edge per harness. The deep module is the spine: the
`vader` CLI (state, gate, ledger, ratchet, recall, persist) plus the protocol and the
acceptance gate. None of that knows which harness drives it. An adapter is the thin interface
that lets a given agent host run a tick.

## The adapter contract

An adapter does exactly three things. Nothing more belongs in it.

1. Drive the CLI. Run `vader recall` to rehydrate, `vader gate` to judge, `vader persist` to
   close the tick. These calls are identical on every harness; the adapter only shells out.
2. Fan out owners and verifiers using the harness native primitive. Owners mutate files in
   parallel, so the adapter must isolate them (a worktree per owner off the item base sha) or
   serialize them. Verifiers are read-only and run the acceptance gate.
3. Assemble the run report and hand it to `vader persist`. The shape is fixed (see
   `references/recipes.md`); the adapter fills it from the fan-out results.

The contract is the thin interface. Everything hard (what a gate means, when a ratchet grants,
why a model change parks) lives once in the spine. Adapters never re-implement judgment; they
carry data to and from the CLI.

## Fan-out primitive per harness

| Harness | Primitive | Isolation | Status |
|---|---|---|---|
| Claude Code | the `Workflow` tool (agent / parallel / pipeline) | `isolation: 'worktree'` per owner | working |
| Pi | `extensions/vader` plus pi-subagents | worktree per subagent | implemented (extension, unit-tested) |
| Codex | native subagents, else sequential | worktree or serialize | shared `planTick` plus sequential fallback |
| Hermes | native subagents, else sequential | worktree or serialize | shared `planTick` plus sequential fallback |

Every adapter consumes the same plan. `planTick(recall)` (exported from the engine) is the
single source of truth for the fan-out: it returns `seamFirst` (run sequentially, before any
sibling) and `siblings` (run in parallel), and stamps each slice with a `voters` count that is
3 for a seam, never-ratchet, or previously-bounced class and 1 otherwise. Because the plan is
computed once in the spine, the Claude Workflow path, the Pi extension, and the sequential
fallback cannot drift in WHAT they run; they differ only in HOW they execute it.

Where a harness has no fan-out primitive, the adapter falls back to sequential: same
`planTick` output, owners one at a time, parallel siblings simply run in series (a high-risk
slice still earns its full `voters` panel as sequential passes). The report and the gate are
byte-for-byte the same as the parallel path, so a tick is reproducible across harnesses. The
only difference a fallback makes is wall-clock.

Honesty note on maturity: the Pi extension and `planTick` are unit-tested in this repo
(`extensions/vader/extension.test.ts`, `skills/vader/scripts/vader.test.ts`). End-to-end runs
on Pi, Codex, and Hermes are validated by the operator on those runtimes, since they cannot be
driven from the Claude Code host where these tests run.

## The Claude Code adapter (Phase 1, working)

The `/vader` command is the adapter. It reads `references/protocol.md` and runs the
`vader-tick` Workflow script in `references/recipes.md`:

- Recall: `vader recall --root <repo>` feeds `topBounces`, `ratchet`, stamps, and the next
  item into the script `args`.
- Fan out: the Workflow script spawns the critic, the seam owner alone, the sibling owners in
  parallel (each `isolation: 'worktree'`), then the cross-assigned verifiers whose voter count
  scales with `topBounces`.
- Gate: `vader gate --root <repo>` is the deterministic arbiter; a failed invariant id is an
  automatic bounce.
- Persist: the assembled `RunReport` goes to `vader persist --root <repo>`. A model change
  parks for the human gate; a green build tick marks the item done.

The loop self-paces with `ScheduleWakeup` between ticks and stops on a human gate (freeze the
model, or change the model) or an exhausted roadmap.

## Writing a new adapter

Port the four CLI calls verbatim, then bind the harness fan-out primitive to the four phases in
`references/recipes.md` (critic, seam, owners, verify). If the host has no parallelism, bind
the sequential fallback. Do not add a second gate, a second ledger, or a second persist path:
one pattern per concern. The adapter is finished when a tick driven through it produces the
same `RunReport` and the same `vader gate` verdict as the Claude Code adapter on the same
input.
