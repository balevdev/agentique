# Roadmap and decomposition

Read this during Phases 1 and 2. It covers two jobs: running the design tournament that
chooses the shape, and turning the chosen shape into a disjoint plan where every slice has
exactly one owner, a frozen seam surface, and acceptance criteria you can check. The
disjointness and the testable criteria are worth more than the automation, so when the plan
fights you, fix it by hand.

## The design tournament (Phase 1)

The goal is to commit to a shape only after it has survived a challenge, because reversing a
shape after slices are built is the most expensive thing this protocol can do.

1. Brief the proposers from `MISSION.md` only. Give each the mission, the constraints, and
   the non goals. Do not give them a preferred approach, and do not let them see each other,
   so the proposals stay genuinely different.
2. Each proposer returns a complete approach: the architecture and module boundaries, the
   key data flows, the build sequence, the main tradeoffs, and the riskiest assumption it is
   making. A proposal that hides its risk is weaker than one that names it.
3. Critics red team every proposal against the constraints. Look for failure modes, hidden
   cost, irreversible decisions, and places the proposal quietly assumes work that is not in
   scope. Score each on the design selection rubric in `handoff-schemas.md`.
4. Synthesize. Pick the winning spine, then graft the strongest specific ideas from the
   runners up where they do not fight the spine. Write `.mission-control/DESIGN.md` with the
   chosen approach,
   each rejected alternative, and the one line reason it lost. The rejected list is not
   bookkeeping. It is what stops the team from relitigating settled choices mid build.

## From design to slices (Phase 2)

Derive the work breakdown from `DESIGN.md`, not from an import graph, because for new work
the edges do not exist yet. The chosen design already names the module boundaries. Use them.

1. Sequence into milestones ordered by dependency and risk. The riskiest and most depended
   on work goes first, so a wrong assumption surfaces while it is still cheap to change. A
   milestone is a coherent increment that leaves the repo working, not an arbitrary batch.
2. Within the milestone in scope, carve disjoint slices at the design's module boundaries.
3. Assign every shared seam to exactly one owner slice and freeze it for the sprint.
4. Write a contract per slice (format below) and approve them before any builder starts.

## Prefer vertical slices

A vertical slice owns a thin end to end path through the system, for example one feature's
UI, its API handler, and its data access, rather than one horizontal layer shared across
features. Prefer vertical slices. A vertical slice can be verified as real behavior the
moment it lands, it delivers value on its own, and its acceptance criteria are observable. A
horizontal layer delivers nothing until the last layer lands, so it cannot be accepted in
isolation and it hides integration risk until the end. Use a horizontal slice only for
genuinely shared foundation that several verticals must consume, and when you do, make it a
seam owner (see below) and sequence it first.

## Slice sizing

Balance slices by size and complexity, not by file count alone. Aim for a slice a single
agent can hold in context along with `MISSION.md`, `DESIGN.md`, and the contract. A slice
that spans many shallow unrelated paths is a smell and usually means the cut was wrong. If a
slice is too large to reason about, split it and add a builder, or narrow the milestone. If
the work is small, collapse to fewer builders but keep at least one verifier per team. Never
merge a builder and its verifier into one agent. By default run up to six builders across
two teams with one verifier each, and scale down for small missions.

## Frozen seam selection

A seam is any type, contract, schema, API, or shared module that more than one slice
depends on. Seams are where parallel work breaks, because a change on one side silently
breaks the other. In forward work many seams do not exist yet, so the owner's first job is
to define the seam, publish it, and then hold it stable. Rules:

- A non owner never edits a seam. It builds against the published seam and escalates if the
  seam is wrong, then proceeds with everything not blocked.
- The owner defines and may revise its own seam, but logs every change so dependents re
  verify against the new shape.
- Put the shared contracts and shared foundation each under their own slice and sequence
  them first, so the most depended on surface has a single accountable owner and exists
  before the slices that consume it.

## The slice contract

The contract is the gate between planning and building. It freezes the seam and acceptance
surface, never the internals. Keep it short and concrete.

```
# Contract: <slice id> <slice name>
Owner: <AGENT>   Paths: <globs this slice may write>   Milestone: <m>

## Exposes (seam this slice owns)
- <type / endpoint / schema / module API> : <one line of meaning>

## Consumes (seams owned elsewhere)
- <seam> owned by <slice id>

## Acceptance criteria
- [AC1] <observable behavior>, checked by <test name or observable check>
- [AC2] ...

## Out of scope
- <explicitly not built here>
```

Every acceptance criterion must be expressible as a test or an observable check. If a
criterion cannot be phrased that way, it is an opinion, not a contract, and it will make
verification a matter of taste. Rewrite it until it is checkable, or drop it.

## Worked example

A new "saved searches" feature on a product plus data app. Names and paths change per repo,
the structure does not. The shared contracts slice is sequenced first and frozen, then the
remaining vertical slices build against it, split across two teams of two slices each with
one verifier per team.

| Team    | Agent  | Slice                                                                     |
|---------|--------|---------------------------------------------------------------------------|
| Core    | FN-C   | packages/contracts: SavedSearch types and API schema (frozen seam owner)  |
| Core    | PR-API | apps/api: saved search endpoints and persistence                          |
| Surface | PR-UI  | apps/web: saved search create, list, and delete UI plus its data hooks    |
| Surface | DT-IX  | apps/platform: index saved searches for the alerting pipeline             |

Here the contracts slice owns the only shared seam and ships first, the Core team owns the
data path and the Surface team owns the consuming verticals, each remaining slice is a
vertical that can be accepted as real behavior on its own, no slice writes another's paths,
and every slice has acceptance criteria phrased as checks.
