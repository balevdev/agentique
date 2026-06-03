# agentique

A small house of well-mannered agent skills. Agents that say *bonjour* before they `sudo`, ask *pardon* before they push, and never finish a sentence with an em dash. *Agent* plus *étiquette*: skills with savoir-vivre.

Distributed through the open [skills.sh](https://skills.sh) ecosystem.

## Install

```bash
# install the whole catalogue
npx skills add balevdev/agentique

# or pick a single skill
npx skills add balevdev/agentique --skill jarvis-anakin-mission
```

Pass `-g` for a global install, or `-a claude-code` (etc.) to target one agent. See `npx skills add --help` for the full set.

## Skills in this repo

### [`jarvis-anakin-mission`](skills/jarvis-anakin-mission/SKILL.md)

A drop-in, harness-agnostic protocol for pointing a disciplined team of agents at one repo. One agent conducts; owners each take a disjoint slice; independent verifiers accept the work they did not write. The output is a roadmap or capability map, a clean diff, and a result you can defend from that diff. It runs in one of two modes, chosen by intent, over a single shared spine.

**`mode: build`** diverges then converges for new work. It decomposes the goal, optionally runs a design tournament that independent critics red team so the plan is stress tested before any code exists, then owners ship their slices against a frozen contract while verifiers surface what is missing. It writes only under `.mission-control/`, and recommends a review when the build is done to harden the result. Use it to plan and build a large feature or roadmap, break a big ambiguous idea into a sequenced plan, weigh competing architectures before committing, or coordinate several agents to ship something new.

**`mode: review`** converges on an existing repo. Owners partition it off its real module boundaries, inventory what each slice does, and fix what is wrong; verifiers audit the fixes they did not write. It writes only under `.team-review/`, so a review and a build on the same repo never collide. Use it to audit, review, harden, or fix a codebase, inventory its capabilities, or point several agents at one repo without them colliding.

Both modes run the same five phases, the same three execution modes (Parallel Teams for many parallel subagents, Sequential Slices for serial ones, Solo for hosts with no subagent primitive at all), the same one structured handoff per agent, and the same ready or blocked verdict backed by named checks. The agent count is sized from the repo's real module boundaries, not a fixed shape.

### [`skywalker-workflows`](skills/skywalker-workflows/SKILL.md)

The same Anakin sprint, native to hosts that can coordinate many agents. In Pi, it uses the companion Skywalker extension plus `pi-subagents`: the extension collects the mission, then the parent agent grounds the repo, slices it into disjoint owners, approves contracts, launches owner/verifier chains, and gates the result. In Claude Code, it can still use dynamic workflows when the Workflow tool is present.

The win is leanness. The session plans (grounds the repo, slices it into disjoint owners, freezes each contract), launches one runtime fanout that runs owners and cross assigned verifiers, then gates the result against baseline. Pi uses async subagent chains and file artifacts; Claude Code uses workflow script variables and runtime status. Reach for it when the slice count is more than a couple, when you want Claude Code workflow-style orchestration in Pi, or when independent verifiers need to accept work they did not write.

### [`extensions/skywalker`](extensions/skywalker/index.ts)

A Pi companion extension for `skywalker-workflows`. It registers `/skywalker`, `/skywalker-preview`, `/skywalker-status`, and `/skywalker-clear`. The extension does not edit code or spawn subagents directly; it creates a structured kickoff prompt so the parent Pi agent remains the orchestrator.

To install manually into Pi:

```bash
mkdir -p ~/.pi/agent/extensions/skywalker
cp extensions/skywalker/index.ts ~/.pi/agent/extensions/skywalker/index.ts
/reload
```

Then run:

```text
/skywalker review apps/api --concurrency 4 --worktree single-tree
```

## Repo layout

```
agentique/
├── extensions/
│   └── skywalker/
│       ├── index.ts                 # Pi companion slash commands and TUI wizard
│       └── extension.test.ts        # behavior tests for prompt/status state
└── skills/
    ├── jarvis-anakin-mission/
    │   ├── SKILL.md
    │   └── references/
    │       ├── protocol.md          # the spine: one invariant, mantra, flow rules, five phases
    │       ├── execution-modes.md   # the three execution modes, VCS isolation, budgets
    │       ├── handoff-schemas.md   # the one structured handoff artifact and verdict rubric
    │       ├── build-delta.md       # Phase 1 for mode: build
    │       └── review-delta.md      # Phase 1 for mode: review
    └── skywalker-workflows/
        ├── SKILL.md
        └── references/
            ├── pi-subagent-runtime.md # Pi-native phase map and chain shapes
            ├── protocol.md            # the invariant, mantra, session vs workflow split, phase map
            └── recipes.md             # copyable script: meta, schemas, build skeleton, review delta
```

The CLI auto-discovers any directory under `skills/` that contains a `SKILL.md` with a `name` and `description` in its YAML frontmatter. Adding a new skill is a matter of dropping a new folder in.

> Previous releases shipped this as two skills, `anakin-mission-control` (build) and `jarvis-snowden-academy` (review). They are now one `jarvis-anakin-mission` skill with a `mode` switch over a single shared spine, since skills.sh installs one skill directory at a time and the two shared ~70% of their text.

## License

MIT. See [LICENSE](LICENSE).
