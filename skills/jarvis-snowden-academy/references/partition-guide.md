# Partition guide

Read this during Phase 1. The goal is a disjoint partition where every file has exactly
one writer and shared seams have exactly one owner. The disjointness guarantee is worth
more than the automation, so when the graph fights you, fix the cut by hand.

## The two way cut

1. Build the module and dependency graph from the workspace config and the import edges in
   `GROUNDING.md`.
2. Find the cut that splits modules into two halves while minimizing the number of edges
   crossing between them. The two halves become the two teams. Preferred splits, in order:
   product or runtime surface versus data or platform or infra surface, then frontend
   versus backend, then application versus library.
3. Within each team, carve three disjoint slices at module boundaries.

## Slice sizing

Balance slices by size and complexity, not by file count alone. A slice that is one large
deep module is fine. A slice that spans many shallow unrelated modules is a smell and
usually means the cut was wrong. Aim for slices a single agent can hold in context along
with `GROUNDING.md`. If a slice is too large to reason about, split it and add an agent, or
narrow the sprint scope. If the repo is too small for six slices, collapse to fewer workers
but keep at least one verifier per team. Never merge a doer and its verifier into one
agent.

## Frozen seam selection

A seam is any type, contract, schema, or public package API that more than one slice
imports. Seams are where parallel work breaks, because a change on one side silently
breaks the other. Assign every seam to exactly one owner slice and freeze it for the
sprint. Rules:

- A non owner never edits a seam. It escalates and proceeds with everything not blocked.
- The owner may edit its own seam, but logs the change so dependents re verify.
- Put the shared contracts and shared infra packages each under their own slice, so the
  most dangerous edits have a single accountable owner.

## Worked example

A product plus data monorepo. Names and paths change per repo, the structure does not.

| Team          | Agent | Slice                                                                    |
|---------------|-------|--------------------------------------------------------------------------|
| Fullstack     | FS-W  | apps/web                                                                 |
| Fullstack     | FS-A  | apps/api                                                                 |
| Fullstack     | FS-D  | packages/{design,contracts,core}   (frozen seam owner)                   |
| Data Platform | DP-P  | apps/platform pipeline plus adapters plus index                          |
| Data Platform | DP-X  | apps/platform domains (alert, mandate, mandate-event, organisation, ...) |
| Data Platform | DP-I  | packages/{db,lakehouse,pipeline-bus,config} plus infra (frozen seam owner)|

Here the cut separates the runtime product surface from the data platform surface, the two
shared package groups each get a single owner and are frozen, and no file appears in two
slices.
