---
name: skywalker-workflows
description: "Run the Anakin multi agent sprint natively as a Claude Code dynamic workflow, in build or review mode. The session plans (ground the repo, slice it into disjoint owners, freeze each slice's contract) then launches ONE workflow script that fans out the owners and the independent verifiers, and finally gates the result against baseline. build mode turns a feature or roadmap into shipped verified code; review mode audits, hardens, and fixes an existing repo. The workflow runtime holds the orchestration, so intermediate results stay in script variables instead of the session context, and structured agent output carries the per agent handoffs (with a durable disk copy kept as the artifact the gate and the human read). Use this whenever the user wants the Anakin build or review sprint AND the Workflow tool is available, says run the sprint as a workflow, asks to fan out owners and verifiers as a workflow, or wants several agents pointed at one repo without collisions using Claude Code workflows. If the Workflow tool is NOT available (a host with pi agents, serial only subagents, or no subagents), use jarvis-anakin-mission instead; the protocol is identical, only the executor changes."
---

# Skywalker Workflows

The Anakin agent sprint, expressed as a Claude Code dynamic workflow. Same protocol as
`jarvis-anakin-mission`: one orchestrator, owners who each hold a disjoint slice, and independent
verifiers who accept work they did not write. The difference is the executor. Here the
orchestration lives in a workflow script the runtime executes in the background, so the session
context holds only the plan and the final verdict, not the turn by turn transcript of every agent.

Use this when the Workflow tool is available. If it is not (a pi agent host, serial only
subagents, or no subagents at all), use `jarvis-anakin-mission`; the invariant, the mantra, the
phases, and the schemas are identical, and only who runs each phase changes.

## When this beats hand spawning

Reach for the workflow form when the slice count is more than a couple, when you want the
orchestration as a script you can read, rerun, and resume, or when you want a quality pattern
baked in (cross assigned verifiers, adversarial refute, loop until dry). For one or two slices,
hand spawning with the Agent tool is simpler and you should prefer it.

## The shape: plan in the session, fan out in the workflow, gate in the session

The protocol splits across two contexts at the one natural seam. The split is the whole design,
so honor it:

1. **Plan (session).** Ground the repo and slice it into disjoint owners with frozen contracts.
   This needs iteration and your approval, so it stays in the main loop. Write `GROUNDING.md`,
   `SLICES.md`, the per slice contracts, and in build mode `DESIGN.md`, to disk. Approve the
   contracts before any code is written.
2. **Fan out (workflow).** Author ONE workflow script that spawns the owners and the independent
   verifiers, and launch it. It returns structured verdicts into a script variable, not prose into
   your context. A workflow takes no mid run input, which is exactly why planning and sign off
   happen before it, never inside it.
3. **Gate (session).** When the workflow returns, run the full repo suite yourself against the
   baseline, route regressions back to their owning slice, and write `SUMMARY.md`. The gate needs
   full repo shell and judgment, so it belongs in the session, not the script.

## Reference files

- `references/protocol.md`: the one invariant, the engineering mantra, the session vs workflow
  split, the phase to primitive map, and what the workflow form lets you drop. Read this first.
- `references/recipes.md`: the copyable script idioms. The `meta` block, the owner preamble (with
  context discipline), the owner and verifier output schemas (returned as structured output plus a
  durable disk copy), the refute first verifier, a build skeleton, the review delta with discovered
  seam sequencing, model routing and what NOT to route, the optional N voter and gate triage patterns,
  the failure and loop patterns, resume, and the plain JavaScript gotchas. Read this when you author
  the script.
