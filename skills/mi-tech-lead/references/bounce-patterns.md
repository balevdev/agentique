# Bounce Patterns — Factory Defect Ledger

## Per-class bounce history

### `etl-fetcher` (5 bounces across 7 runs)

| Bounce | Run | AC | Reason | Pre-emption |
|--------|-----|----|--------|-------------|
| 1-3 | live-cluster-e2e | AC3 | Mid-flight typecheck noise — in-flight sibling files cause cross-slice typecheck failures | Sequence seam owners first; verify when siblings are done. Injected into owner preamble. |
| 4 | code-alignment-sweep | AC5 | Single-use export-for-test: `DEFAULT_CATALOGUE` exported by lgps fetcher solely for test import | Owner preamble: "test through public surface with recording transport, never export-for-test" |
| — | Various | — | Pattern observed: fetchers that add new helper functions often inline them in the fetcher instead of adding to `source-fetchers/shared.ts` | Check: "does this helper exist at shared.ts? If not, and this is the 3rd inline copy, add it there." |

### `seam` (3 bounces across 7 runs)

| Bounce | Run | AC | Reason | Pre-emption |
|--------|-----|----|--------|-------------|
| 1-2 | etl-promotion-system-eval | AC3, AC5 | Logic edits in moved files (move was supposed to be rename+import only); LOC count drifted from contracted number | Seam owner preamble: "move-only, no functional changes. Verify LOC counters before submitting report." |

### `etl-orchestration` (1 bounce)

| Bounce | Run | AC | Reason | Pre-emption |
|--------|-----|----|--------|-------------|
| 1 | etl-promotion-system-eval | AC4 | Owner claimed eslint clean; own test file had 2 import/order errors | Owner preamble: "run eslint on your OWN slice paths before submitting report" |

### `api` (3 bounces — from early runs before galaxy seeding)

| Pattern | Details |
|---------|---------|
| Hollow test | AC claimed but no code behind it — test file existed but test body was empty or skipped |
| No code behind AC | Contract AC referenced a feature that was not implemented |
| Integration gap | Router test passed with fake data but didn't exercise the real service path |

### `ui` (0 bounces)

Web slice has never bounced. Consistent quality pattern.

## Bounce trend

- **Run 1-1** (code-smell-sweep): 0 bounces (review of existing code)
- **Run 1-2** (live-cluster-e2e): 3 bounces (all etl-fetcher, typecheck noise)
- **Run 1-3** (code-alignment-sweep): 1 bounce (etl-fetcher, export-for-test)
- **Run 1-4** (deterministic-mandate-spine): 0 bounces (clean run)
- **Run 1-5** (maintenance-simplicity-sweep): 0 bounces (behavior-preserving)
- **Run 1-6** (dlq-persistence-replay): 0 bounces (clean run)
- **Run 1-7** (etl-promotion-system-eval): 3 bounces (2 seam, 1 etl-orchestration)

**Improving**: bounces are becoming less frequent and less severe. No bounces in 2 of the last 3 runs.
**Risk**: the seam class is new to bouncing — this signals that structural moves need tighter seam owner discipline.

## Per-verifier voter count recommendation

```
voterCount = {
  seam:            3,  // recently had bounces — spend verification
  etl-fetcher:     3,  // highest total bounces — spend verification
  etl-structurer:  1,  // clean history
  etl-orchestration: 3, // recent bounce
  api:             3,  // hollow-test history
  ui:              1,  // clean history
  ops:             1,  // clean history (infra changes)
  security:        3,  // never auto-license
  migration:       3,  // never auto-license
}

neverRatchet = ['seam', 'security', 'migration']
```