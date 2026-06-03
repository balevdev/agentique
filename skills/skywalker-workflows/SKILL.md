---
name: skywalker-workflows
description: "Run an Anakin/Skywalker multi-agent sprint in build or review mode. Use for big features, roadmap builds, repo audits, hardening passes, parallel owner/verifier work, or requests to run Claude Code-style workflows. In Pi, prefer the Skywalker extension plus pi-subagents: ground, slice, approve contracts, run owners, run independent verifiers, then gate in the parent session. In Claude Code with the Workflow tool, use dynamic workflows. If neither workflows nor subagents exist, fall back to jarvis-anakin-mission."
---

# Skywalker Workflows

The Anakin agent sprint for hosts that can coordinate many agents. Same protocol as
`jarvis-anakin-mission`: one orchestrator, owners who each hold a disjoint slice, and independent
verifiers who accept work they did not write. The difference is the executor.

Runtime selection:

1. **Pi agent with `pi-subagents` and the Skywalker extension:** use the Pi-native runtime in
   `references/pi-subagent-runtime.md`. The extension collects the mission and the parent agent
   launches async subagent chains. This is the preferred Pi path.
2. **Claude Code with the Workflow tool:** use the dynamic workflow runtime in
   `references/protocol.md` and `references/recipes.md`.
3. **No workflow tool and no usable subagents:** fall back to `jarvis-anakin-mission`; the invariant,
   phases, and schemas are identical, only the executor changes.

## When this beats hand spawning

Reach for Skywalker when the slice count is more than a couple, when you want a durable run shape
that can be inspected or repeated, or when you want a quality pattern baked in (cross assigned
verifiers, adversarial refute, loop until dry). In Pi, prefer the extension command `/skywalker`
for interactive setup and use `subagent` chains for the actual owner/verifier fanout. For one or
two slices, hand spawning with the Agent or `subagent` tool is simpler and you should prefer it.

## The shape: plan in the session, fan out in the runtime, gate in the session

The protocol splits across two contexts at the one natural seam. The split is the whole design,
so honor it:

1. **Plan (session).** Ground the repo and slice it into disjoint owners with frozen contracts.
   This needs iteration and your approval, so it stays in the main loop. Write `GROUNDING.md`,
   `SLICES.md`, the per slice contracts, and in build mode `DESIGN.md`, to disk. Approve the
   contracts before any code is written.
2. **Fan out (runtime).** In Claude Code, author ONE workflow script that spawns the owners and
   independent verifiers. In Pi, launch ONE async `subagent` chain or a small sequence of chains
   with named phases and file-only artifacts. Either way, planning and sign off happen before
   fanout, never inside it.
3. **Gate (session).** When the workflow returns, run the full repo suite yourself against the
   baseline, route regressions back to their owning slice, and write `SUMMARY.md`. The gate needs
   full repo shell and judgment, so it belongs in the session, not the script.

## Reference files

- `references/pi-subagent-runtime.md`: Pi-native phase mapping, safe chain shapes, artifacts,
  status, and gate rules. Read this first when running inside Pi.
- `references/protocol.md`: the one invariant, the engineering mantra, the session vs workflow
  split, the phase to primitive map, and what the workflow form lets you drop. Read this for
  Claude Code dynamic workflows or for the shared protocol.
- `references/recipes.md`: the copyable Claude Code workflow script idioms. Read this when you
  author a dynamic workflow script.
