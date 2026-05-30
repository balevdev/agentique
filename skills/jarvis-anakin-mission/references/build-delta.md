# Build delta (Phase 1, mode: build)

Read this in Phase 1 when `mode: build`. It covers two jobs: choosing the shape, then turning the
chosen shape into a disjoint plan where every slice has one owner, a frozen seam surface, and
acceptance criteria you can check. The disjointness and the checkable criteria are worth more than
any automation, so when the plan fights you, fix it by hand.

## Choose the shape (lean by default)

Picking the wrong shape is the most expensive mistake in forward work, and it is cheapest to catch
before any code exists. But most missions do not need a tournament to find their shape.

- Default: one design pass plus one critic pass. The orchestrator (or one proposer) drafts a
  complete approach: architecture and module boundaries, key data flows, build sequence, main
  tradeoffs, and the riskiest assumption. One independent critic red teams it against the
  constraints in `GROUNDING.md`. The orchestrator then writes `DESIGN.md`.
- Escalate to a full tournament only when Phase 0 flagged real architectural uncertainty: multiple
  viable stacks, an irreversible bet, or a boundary the team cannot agree on. Then run two or three
  proposers who do not see each other, so the approaches stay genuinely different, plus two critics
  who score each proposal. Synthesize: pick the winning spine and graft the strongest ideas from
  the runners up. Degrade per `execution-modes.md` when subagents are scarce.

Either way, `DESIGN.md` records the chosen approach, the rejected alternatives, and the one line
reason each lost. The rejected list is what stops the team relitigating settled choices mid build.
A proposal that hides its riskiest assumption is weaker than one that names it.

## From design to slices

Derive the work breakdown from `DESIGN.md`, not from an import graph, because for new work the
edges do not exist yet. The chosen design already names the module boundaries; use them.

1. Sequence into milestones ordered by dependency and risk, riskiest and most depended on first, so
   a wrong assumption surfaces while it is still cheap to change. A milestone leaves the repo working.
2. Within the milestone in scope, carve disjoint slices at the design's module boundaries. Size the
   owner count from those boundaries, not a fixed shape.
3. Assign every shared seam to exactly one owner and freeze it for the sprint.
4. Write a contract per slice and approve them before any builder starts.

## Prefer vertical slices

A vertical slice owns a thin end to end path, for example one feature's UI, its API handler, and its
data access, rather than one horizontal layer shared across features. A vertical slice can be
verified as real behavior the moment it lands and its acceptance criteria are observable. A
horizontal layer delivers nothing until the last layer lands, so it hides integration risk until the
end. Use a horizontal slice only for genuinely shared foundation several verticals must consume, and
when you do, make it a seam owner and sequence it first.

## Frozen seam selection

A seam is any type, contract, schema, API, or shared module more than one slice depends on. In
forward work many seams do not exist yet, so the owner's first job is to define the seam, publish it,
and hold it stable. A non owner builds against the published seam and escalates if it is wrong, then
proceeds with everything not blocked. The owner may revise its own seam but logs every change so
dependents re verify. Put the shared contracts and shared foundation each under their own slice and
sequence them first, so the most depended on surface has one accountable owner and exists before its
consumers.

## The slice contract

The contract is the gate between planning and building. It freezes the seam and acceptance surface,
never the internals. Keep it short and concrete.

```
# Contract: <slice id> <slice name>
Owner: <AGENT>   Paths: <globs this slice may write>   Milestone: <m>

## Exposes (seam this slice owns)
- <type / endpoint / schema / module API> : <one line of meaning>

## Consumes (seams owned elsewhere)
- <seam> owned by <slice id>

## Acceptance criteria
- [AC1] <observable behavior>, checked by <test name or observable check>

## Out of scope
- <explicitly not built here>
```

Every acceptance criterion must be expressible as a test or an observable check. If a criterion
cannot be phrased that way it is an opinion, not a contract; rewrite it until it is checkable or drop
it.

## Worked example (one shape, not the law)

A new saved searches feature. Names and paths change per repo, the structure does not. The contracts
slice owns the only shared seam and ships first; the remaining vertical slices build against it. A
smaller feature with one natural module would run a single owner in Solo, no teams at all.

| Team    | Agent  | Slice                                                                    |
|---------|--------|--------------------------------------------------------------------------|
| Core    | FN-C   | packages/contracts: SavedSearch types and API schema (frozen seam owner) |
| Core    | PR-API | apps/api: saved search endpoints and persistence                         |
| Surface | PR-UI  | apps/web: saved search create, list, delete UI plus its data hooks       |
| Surface | DT-IX  | apps/platform: index saved searches for the alerting pipeline            |
