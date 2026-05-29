# agentique

A small house of well-mannered agent skills. Agents that say *bonjour* before they `sudo`, ask *pardon* before they push, and never finish a sentence with an em dash. *Agent* plus *étiquette*: skills with savoir-vivre.

Distributed through the open [skills.sh](https://skills.sh) ecosystem.

## Install

```bash
# install the whole catalogue
npx skills add balevdev/agentique

# or pick a single skill
npx skills add balevdev/agentique --skill jarvis-snowden-academy
```

Pass `-g` for a global install, or `-a claude-code` (etc.) to target one agent. See `npx skills add --help` for the full set.

## Skills in this repo

### [`jarvis-snowden-academy`](skills/jarvis-snowden-academy/SKILL.md)

A drop-in, harness-agnostic protocol for pointing a disciplined team of agents at a single repo. One agent conducts (Jarvis). Workers each own a disjoint slice, inventory what it does, and fix what is wrong. Independent verifiers audit the work they did not write. The output is a capability map and a score you can defend from the diff.

Works with hosts that spawn many parallel subagents (Parallel Teams mode), hosts that spawn them serially (Sequential Slices mode), and hosts with no subagent primitive at all (Solo mode). Same phases, artifacts, and scoring across all three.

Use it when you want to audit, review, harden, or fix a codebase with multiple agents without them colliding.

### [`anakin-mission-control`](skills/anakin-mission-control/SKILL.md)

The forward twin of the review sprint. One agent conducts (Anakin) and decomposes the goal. A design panel proposes rival approaches that independent critics red team, so the plan is stress tested before any code exists. Builders each own a disjoint slice and ship it against a frozen contract, while independent verifiers accept work they did not write and surface what is missing. The output is a roadmap, a clean diff, and a readiness score you can defend from that diff.

Same three execution modes as its sibling (Parallel Teams, Sequential Slices, Solo), so it runs on any host whether or not it spawns subagents. It writes only under `.mission-control/`, so it never collides with a review sprint, and recommends one when the build is done to harden the result.

Use it when you want to plan and build a large feature or roadmap, break a big ambiguous idea into a sequenced plan, weigh competing architectures before committing, or coordinate several agents to ship something new without them colliding.

## Repo layout

```
agentique/
└── skills/
    ├── anakin-mission-control/
    │   ├── SKILL.md
    │   └── references/
    │       ├── execution-modes.md
    │       ├── handoff-schemas.md
    │       └── roadmap-and-decomposition.md
    └── jarvis-snowden-academy/
        ├── SKILL.md
        └── references/
            ├── execution-modes.md
            ├── handoff-schemas.md
            └── partition-guide.md
```

The CLI auto-discovers any directory under `skills/` that contains a `SKILL.md` with a `name` and `description` in its YAML frontmatter. Adding a new skill is a matter of dropping a new folder in.

## License

MIT. See [LICENSE](LICENSE).
