# Review delta (Phase 1, mode: review)

Read this in Phase 1 when `mode: review`. The goal is a disjoint partition where every file has
exactly one writer and every shared seam has exactly one owner. The disjointness guarantee is worth
more than any automation, so when the graph fights you, fix the cut by hand.

## Partition off real boundaries

1. Build the module and dependency graph from the workspace config and the import edges recorded in
   `GROUNDING.md`.
2. Carve disjoint slices at module boundaries. Size the owner count from the boundaries the repo
   actually has, not a fixed shape: a small repo with one natural module runs a single owner in
   Solo; a larger repo splits into as many slices as its boundaries support.
3. Group slices into teams only when the slice count warrants a verifier per team. When you do
   group, the natural cut is the one that minimizes edges crossing between halves, preferring product
   or runtime surface versus data or platform surface, then frontend versus backend, then
   application versus library.

A slice that is one large deep module is fine. A slice that spans many shallow unrelated modules is a
smell and usually means the cut was wrong. Aim for slices a single agent can hold in context along
with `GROUNDING.md`. Never merge an owner and its verifier into one agent.

## Frozen seam selection

A seam is any type, contract, schema, or public package API more than one slice imports. Assign every
seam to exactly one owner and freeze it for the sprint. A non owner never edits a seam; it escalates
and proceeds with everything not blocked. The owner may edit its own seam but logs the change so
dependents re verify. Put the shared contracts and shared infra packages each under their own slice,
so the most dangerous edits have one accountable owner.

## Worked example (one shape, not the law)

A product plus data monorepo. Names and paths change per repo, the structure does not. Here the cut
separates the runtime product surface from the data platform surface, the two shared package groups
each get a single owner and are frozen, and no file appears in two slices. A smaller repo would
collapse to fewer owners on one team.

| Team          | Agent | Slice                                                                     |
|---------------|-------|---------------------------------------------------------------------------|
| Fullstack     | FS-W  | apps/web                                                                   |
| Fullstack     | FS-A  | apps/api                                                                   |
| Fullstack     | FS-D  | packages/{design,contracts,core}   (frozen seam owner)                    |
| Data Platform | DP-P  | apps/platform pipeline plus adapters plus index                           |
| Data Platform | DP-X  | apps/platform domains (alert, mandate, mandate-event, organisation, ...)  |
| Data Platform | DP-I  | packages/{db,lakehouse,pipeline-bus,config} plus infra (frozen seam owner) |
