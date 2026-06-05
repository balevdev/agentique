# Ratchet: evidence-licensed autonomy

The ratchet answers one question per slice class: how much human gating does this class
of work still need? It is ADVISORY ONLY. The CLI computes verdicts and records grants; it
never merges, never approves contracts, never acts. Acting on a verdict is always a
session decision, and granting a level always requires a named human approver.

## Levels

| Level | Meaning |
|-------|---------|
| L0 (default) | human approves contracts AND the final gate |
| L1 | contracts auto-approved when inside the proven partition with no seam changes; human still gates the result |
| L2 | the session may gate to a staging branch on its own; human reviews staging asynchronously |

## Evidence rules (computed from the ledger, deterministic)

- A run counts for a class only if it touched the class. Clean = gate `green` AND every
  slice of that class accepted with zero bounces.
- L1 eligible: 2 consecutive clean runs. L2 eligible: 3 consecutive clean runs.
- Runs not touching the class neither extend nor break the streak.
- Any bounce in the class, or any non-green gate on a run touching it, resets the streak
  to zero AND automatically demotes an existing grant to L0 at persist time. Demotion is
  mechanical and immediate; promotion is never automatic.
- Never-ratchet classes (`seam`, `security`, `migration` by default) are never eligible
  regardless of evidence. Schema changes, security-adjacent surfaces, and seam ownership
  stay human-gated forever.

## Workflow

```
galaxy ratchet                # verdicts for every class seen in the ledger
galaxy ratchet api            # one class
galaxy ratchet api --grant 1 --approved-by boyan   # record a human-approved promotion
```

A grant above the computed eligibility is refused. A grant without an approver is
refused. Use `--grant` only after the human has explicitly approved the promotion in the
conversation; the approver name goes into state as the accountability record.

## Why dormant-by-default is correct

A fresh factory has no calibration data, so the ratchet can license nothing: every class
holds at L0 until real runs accrue. An autonomy mechanism with no evidence should refuse
to autonomize. Expansion of the operational domain follows measured reliability, the same
way real factories and self-driving deployments ratchet: domain by domain, on evidence,
with automatic contraction on any defect.
