# Vader orchestration recipes

How a tick fans out. The shape is the same for a build tick (one roadmap item, its disjoint
`slicePaths`) and a review run (the whole repo, partitioned into disjoint slices). One engine,
one report, two modes. This file is the Workflow script and the prompts it carries.

The flow, in one line: critic red-teams the plan, the seam owner builds alone, sibling owners
build in parallel, cross-assigned refute-first verifiers run the acceptance gate, and the
voter count scales with measured bounce history. Owners mutate files, so every owner runs in
worktree isolation off the item base sha.

## The owner MANTRA (carried in every owner prompt)

The owner builds inside its `slicePaths` only. It never touches `constitution.model.*` or
`.vader/generated/`. It writes the simplest thing that satisfies the frozen contract, and it
reaches for complexity in this order (the Ladder, an instinct, not a metric):

1. Do not build it if the contract does not require it (YAGNI).
2. Use the language and its standard library before anything else.
3. Use a platform-native capability before installing a dependency.
4. Add a dependency only when it removes more code than it adds.
5. Prefer the smallest correct implementation.

Deep module stays a separate axis from line count. A deep module hides real complexity behind
a thin interface; that is the goal even when it costs lines. The Ladder removes accidental
complexity; it never argues for a shallow module or a leaked interface. When the two pull
against each other, depth and a thin surface win.

Ceiling comments: when an owner deliberately simplifies, it names the ceiling and the upgrade
path inline, so the next reader sees the tradeoff at the call site rather than guessing it.

```ts
// vader: single in-process lock. Ceiling: one node. Upgrade to a per-account lock if
// throughput crosses the seam.
```

## The verifier prompt (the acceptance gate)

The verifier prompt IS `references/acceptance-gate.md`, verbatim. A verifier accepts work it
did not write, runs the five passes, and returns ACCEPT or REJECT with file:line evidence. A
REJECT is a slice `bounce`: it records `{ac, reason}` per failing clause. No verifier blesses
its own slice; assignment is always cross-owner.

## Voter count (scaled by evidence, not by vibes)

Read `topBounces` and `ratchet` from `vader recall`. For each slice:

- 3 voters when the slice is high risk: its class is in `neverRatchet` (seam, security,
  migration), or its class appears in `topBounces`, or it touches a frozen integration seam.
- 1 voter otherwise.

A slice is accepted only by consensus (majority ACCEPT). One REJECT among three on a high-risk
slice bounces it.

## The bounded deletion pass (a verifier lever)

A verifier may run one deletion pass over its slice. It is complexity-only and never touches
behavior. It tags each candidate with exactly one of: delete (dead or unreachable), stdlib
(hand-rolled what the language already gives), native (a platform capability replaces code),
yagni (built beyond the contract), shrink (same behavior, fewer moving parts). It reports a
net line delta. It never fixes a bug in the same pass (a bug is a separate finding), and it
never deletes a deep module to chase a line count. Higher proven autonomy (a granted ratchet
level on the slice class) biases the pass more aggressively; a never-ratchet class gets the
lightest touch.

## The Workflow script

A runnable-shape script for the Claude Code adapter. It drives the vader CLI for the
deterministic spine and uses Workflow primitives for the fan-out. `args` carries the resolved
tick context (root, the item or partition, the slices, the base sha, recall data).

```js
export const meta = {
  name: 'vader-tick',
  description: 'One vader tick: critic, seam owner, sibling owners, refute-first verifiers',
  phases: [
    { title: 'Critic' },
    { title: 'Seam' },
    { title: 'Owners' },
    { title: 'Verify' },
  ],
}

const { slices, baseSha, recall, mantra, gatePrompt } = args
const topClasses = new Set(recall.topBounces.map((b) => b.class))
const neverRatchet = new Set(recall.ratchet.filter((r) => r.neverRatchet).map((r) => r.class))
const highRisk = (s) => neverRatchet.has(s.class) || topClasses.has(s.class) || s.seam === true
const voters = (s) => (highRisk(s) ? 3 : 1)

// Critic red-teams the plan before any code is written.
phase('Critic')
const critique = await agent(
  `Red-team this slice partition against the frozen contract and the invariants. ` +
    `Name every overlap, missing seam, and ordering hazard. Slices: ${JSON.stringify(slices)}`,
  { label: 'critic', schema: CRITIQUE_SCHEMA },
)
if (critique.blocking.length > 0) return { blocked: 'critic', findings: critique.blocking }

// The seam slice (if any) builds alone first, so siblings fork from a settled interface.
phase('Seam')
const seam = slices.find((s) => s.seam === true)
if (seam !== undefined) {
  await agent(ownerPrompt(seam, baseSha, mantra), {
    label: `owner:${seam.id}`,
    phase: 'Seam',
    isolation: 'worktree',
  })
}

// Sibling owners build in parallel, each isolated off the base sha.
phase('Owners')
const siblings = slices.filter((s) => s.seam !== true)
await parallel(
  siblings.map((s) => () =>
    agent(ownerPrompt(s, baseSha, mantra), { label: `owner:${s.id}`, phase: 'Owners', isolation: 'worktree' }),
  ),
)

// Cross-assigned refute-first verifiers run the acceptance gate, voter count by evidence.
phase('Verify')
const verdicts = await parallel(
  slices.flatMap((s) =>
    Array.from({ length: voters(s) }, (_, i) => () =>
      agent(`${gatePrompt}\n\nCONTRACT and DIFF for slice ${s.id}. You did not write it. Voter ${i + 1}.`, {
        label: `verify:${s.id}:${i + 1}`,
        phase: 'Verify',
        schema: VERDICT_SCHEMA,
      }).then((v) => ({ slice: s.id, class: s.class, ...v })),
    ),
  ),
)

// Consensus: a slice passes only if the majority of its voters ACCEPT.
const bySlice = new Map()
for (const v of verdicts.filter(Boolean)) {
  const arr = bySlice.get(v.slice) ?? []
  arr.push(v)
  bySlice.set(v.slice, arr)
}
const sliceResults = [...bySlice.entries()].map(([id, vs]) => {
  const accepts = vs.filter((v) => v.verdict === 'ACCEPT').length
  const verdict = accepts > vs.length / 2 ? 'accept' : 'bounce'
  const bounces = vs.filter((v) => v.verdict === 'REJECT').flatMap((v) => v.bounces ?? [])
  return { id, class: vs[0].class, verdict, bounces }
})
return { sliceResults }
```

`ownerPrompt(slice, baseSha, mantra)` embeds the MANTRA, the frozen contract for that slice,
the `slicePaths` boundary, and the worktree base sha. `CRITIQUE_SCHEMA`, `VERDICT_SCHEMA`, and
`ownerPrompt` are repo-local; the schemas force structured output so the driver assembles the
run report without parsing prose.

## Assembling the run report

After the script returns, the driver builds one `RunReport` and calls `vader persist`:

- `run`: id, mode (build or review), spec path, commitRange, gate (green / residual / failed
  from the gate result).
- `itemId`: the roadmap item for a build tick; omitted for a review run.
- `slices`: the `sliceResults` from the script.
- `risks`: new risks the critic or verifiers raised, plus a disposition for every open risk
  (persist refuses otherwise).
- `decisions`, `conventions`: anything the run froze.
- `stamps`: the new grounding and partition commits when the baseline advanced.
- `modelChange`: present only when a verifier NOTE proved the constitution must change. Persist
  parks it and blocks the item; a human opens that gate.

## Solo fallback

A host without a fan-out primitive runs the same phases sequentially: critic, seam owner,
sibling owners one at a time, then one verifier per slice (voters collapse to 1, except a
high-risk slice still gets a second independent pass). The report and the gate are identical.
See `references/adapters.md`.
