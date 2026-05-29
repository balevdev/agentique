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

## Repo layout

```
agentique/
└── skills/
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
