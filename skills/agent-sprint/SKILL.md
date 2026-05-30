---
name: agent-sprint
description: Run a multi agent sprint over a codebase in one of two modes. build mode turns a big idea, roadmap, or feature into shipped, verified code: it decomposes the goal, optionally runs a design tournament that independent critics red team, then owner agents each take a disjoint slice and ship it against a frozen contract while independent verifiers accept work they did not write. review mode audits, hardens, and fixes an existing repo: owner agents partition it into disjoint slices, inventory capabilities, fix issues, and independent verifiers accept the fixes they did not write. Both modes leave a roadmap or capability map, a clean diff, and a result you can defend from that diff. Use this whenever the user wants to plan and build a large feature or roadmap, break a big ambiguous idea into a sequenced plan, weigh competing architectures before committing, coordinate several agents to ship something new, OR audit, review, harden, or fix a codebase, mentions agent teams, parallel subagents, a build or review sprint, a capability inventory, or pointing several agents at one repo without them colliding. Works with any agent harness, including ones with no subagents at all.
---

# Agent Sprint

A drop in, harness agnostic protocol for pointing a disciplined team of agents at one repo.
One agent conducts (the orchestrator). A team of owners each holds a disjoint slice.
Independent verifiers accept work they did not write. The output is a roadmap or capability
map, a clean diff, and a result you can defend from that diff.

The protocol runs in one of two modes, chosen by intent:

- `mode: build` diverges then converges for new work. Use it to plan and build a feature or
  roadmap, break a big idea into a sequenced plan, weigh rival architectures, or coordinate
  several agents to ship something new. Phase 1 reads `references/build-delta.md`; all
  artifacts are written under `.mission-control/`.
- `mode: review` converges on an existing repo. Use it to audit, review, harden, or fix a
  codebase, inventory its capabilities, or point several agents at one repo without collisions.
  Phase 1 reads `references/review-delta.md`; all artifacts are written under `.team-review/`.

Pick the mode from the user's intent; if they name one explicitly, honor it. The separate write
roots mean a build run and a review run on the same repo never collide.

Everything else, every phase, value, rule, schema, and execution mode, is identical across the
two modes. To run, read `references/protocol.md` and operate in the chosen mode. Point the
orchestrator here with one line of intent, for example "Run the build sprint to ship this" or
"Run the review sprint on this repo." To resume, run the same line again; if the mode's
`SUMMARY.md` exists, continue from its status and residuals.

## Reference files

- `references/protocol.md`: the full protocol, the one invariant, the engineering mantra, the
  flow rules, the preflight, and the five phases. Read this first.
- `references/execution-modes.md`: preflight checklist, the three execution modes (Parallel
  Teams, Sequential Slices, Solo), VCS isolation, subagent failure handling, budgets.
- `references/handoff-schemas.md`: the one structured handoff artifact, severity, the verdict
  rubric. Read from Phase 2 on.
- `references/build-delta.md`: the design choice and decomposition. Read in Phase 1 when
  `mode: build`.
- `references/review-delta.md`: the repo partition. Read in Phase 1 when `mode: review`.
