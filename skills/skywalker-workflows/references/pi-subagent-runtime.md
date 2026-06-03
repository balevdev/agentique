# Pi Subagent Runtime

Use this reference when running Skywalker in Pi. Pi does not need a fake JavaScript workflow runtime. Use the existing `subagent` extension: async chains, parallel groups, named outputs, file-only artifacts, fresh-context verifiers, optional worktree isolation, and parent-side gating.

## Runtime map

| Skywalker phase | Pi primitive | Owner |
| --- | --- | --- |
| Ground | Parent session, optionally scout/context-builder helpers | Parent |
| Shape and slice | Parent session, approval gate | Parent |
| Fan out owners | `subagent({ chain, async: true })` with phase labels | Parent launches, owners write |
| Verify | Fresh-context `reviewer`/`worker` verifier tasks in later chain phase | Independent verifiers |
| Gate and report | Parent shell and judgment | Parent |

The parent remains the orchestrator. Child agents do not run their own orchestration loops unless they were explicitly assigned a fanout role with `subagent` tools.

## Non-negotiable invariants

- Every slice has exactly one owner.
- No owner writes outside its exclusive paths.
- Shared seams are owned by exactly one slice and sequenced before consumers.
- Planning artifacts are written before fanout: `GROUNDING.md`, `SLICES.md`, and `contracts/<slice>.md`.
- Owners do not commit.
- Verifiers did not write the slice they verify.
- Verifiers inspect the real diff and try to refute each acceptance criterion before accepting.
- The parent runs the final gate. A child-reported pass is evidence, not the gate.

## Artifact roots

- Build mode: `.mission-control/`
- Review mode: `.team-review/`

Suggested layout:

```text
<root>/
  GROUNDING.md
  DESIGN.md                 # build mode when architecture/design is needed
  SLICES.md
  contracts/
    S1-SEAM.md
    S2-API.md
  reports/
    owners/
      S1-SEAM.md
      S2-API.md
    verifiers/
      S1-SEAM.md
      S2-API.md
  SUMMARY.md
```

Use `outputMode: "file-only"` for large owner and verifier handoffs so the parent context receives compact file references instead of huge transcripts.

## Parent flow in Pi

1. Read the brief and repo configuration.
2. Run baseline commands or record why they cannot run.
3. Write `GROUNDING.md` with commands, baseline result, module map, seams, conventions, and risks.
4. Write `SLICES.md` and one contract per slice.
5. Ask the user to approve the contracts before any code-writing owner starts.
6. Launch the owner/verifier chain with `async: true`.
7. Watch status only when useful; do not poll if there is no independent work.
8. When the chain completes, run the full gate in the parent session.
9. Route regressions to the owning slice through bounded fix workers.
10. Write `SUMMARY.md`.

## Safe build chain shape

Use one chain when the slice graph is simple. Sequence seam owners first, then parallel sibling owners, then parallel independent verifiers.

```typescript
subagent({
  async: true,
  context: "fresh",
  chain: [
    {
      agent: "worker",
      phase: "Build seam",
      label: "S1 shared seam",
      as: "s1Owner",
      task: "Read .mission-control/GROUNDING.md and .mission-control/contracts/S1-SEAM.md. You own only the S1 paths listed in the contract. Write the named tests first, implement the seam, run slice-scoped checks only, and write .mission-control/reports/owners/S1-SEAM.md. Do not commit.",
      output: ".mission-control/reports/owners/S1-SEAM.md",
      outputMode: "file-only",
      progress: true
    },
    {
      parallel: [
        {
          agent: "worker",
          phase: "Build owners",
          label: "S2 API",
          as: "s2Owner",
          task: "Read .mission-control/GROUNDING.md and .mission-control/contracts/S2-API.md. Build only your approved paths. Treat S1 as the frozen seam. Run slice-scoped checks only. Write your owner report. Do not commit.",
          output: ".mission-control/reports/owners/S2-API.md",
          outputMode: "file-only",
          progress: true
        },
        {
          agent: "worker",
          phase: "Build owners",
          label: "S3 UI",
          as: "s3Owner",
          task: "Read .mission-control/GROUNDING.md and .mission-control/contracts/S3-UI.md. Build only your approved paths. Treat S1 as the frozen seam. Run slice-scoped checks only. Write your owner report. Do not commit.",
          output: ".mission-control/reports/owners/S3-UI.md",
          outputMode: "file-only",
          progress: true
        }
      ],
      concurrency: 2
    },
    {
      parallel: [
        {
          agent: "reviewer",
          phase: "Verify",
          label: "Verify S1",
          task: "You did not write S1. Read .mission-control/contracts/S1-SEAM.md, the owner report, and the real diff for S1 paths. Try to refute every AC before accepting. Return accept or bounce with evidence. Do not modify project/source files; writing the configured output artifact is allowed.",
          output: ".mission-control/reports/verifiers/S1-SEAM.md",
          outputMode: "file-only"
        },
        {
          agent: "reviewer",
          phase: "Verify",
          label: "Verify S2",
          task: "You did not write S2. Read .mission-control/contracts/S2-API.md, the owner report, and the real diff for S2 paths. Try to refute every AC before accepting. Return accept or bounce with evidence. Do not modify project/source files; writing the configured output artifact is allowed.",
          output: ".mission-control/reports/verifiers/S2-API.md",
          outputMode: "file-only"
        }
      ],
      concurrency: 3
    }
  ]
})
```

## Safe review chain shape

Review mode uses the same mechanics. Owner tasks inventory public behavior, audit correctness and maintainability, and fix only inside their paths. A behavior-preserving refactor needs a characterization test that passes before and after. A real bug fix needs a test that fails on old behavior.

When a review discovers a shared seam, sequence the seam owner before consumers. Do not let two owners edit the same helper, type, enum, adapter, or config file.

## Worktree mode

Default to a single working tree with one writer unless disjoint paths are approved. Use `worktree: true` only when:

- the git state is clean,
- owners need to write concurrently,
- slice paths are disjoint,
- the parent is prepared to inspect and merge the resulting worktree diffs.

If the worktree is dirty, use a single writer or read-only parallel planning/verification fanout.

## Status and TUI

The Skywalker extension gives the human a `/skywalker` wizard, `/skywalker-status`, and `/skywalker-clear`. It does not run subagents itself. It sends a structured kickoff prompt to the parent agent so the parent can apply this skill and keep conversational authority.

Use Pi's existing subagent status controls for live runs:

- `subagent({ action: "status", id })`
- `subagent({ action: "interrupt", id })` only when a run is clearly blocked or drifting
- `subagent({ action: "resume", id, message })` for follow-up instructions

## Gate rules

After owner and verifier phases return, the parent must:

1. Read owner and verifier reports.
2. Inspect the real diff.
3. Run the full repo check once, comparing against the baseline recorded in `GROUNDING.md`.
4. Confirm each milestone AC with code or observable checks.
5. Route regressions to the owning slice through bounded fix workers.
6. Write `SUMMARY.md` with accepted slices, bounced slices, residual risks, commands run, and next actions.

Never call the sprint done just because owners self-reported success.
