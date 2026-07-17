# Decompose: spec → roadmap

Goal: a `ROADMAP.md` where every item is one tick of work producing one
reviewable diff. Decomposition quality is the single biggest lever on factory
quality — a well-cut item almost builds itself; a badly-cut one poisons three
ticks.

## Sizing an item

An item is right-sized when all of these hold:

- **One concern.** It changes one module or one behavior. If describing it needs
  "and", cut it.
- **One diff a human can review in ~5 minutes.** Roughly: one endpoint, one
  component, one migration, one refactor of one file cluster.
- **Completable in one fresh context.** The implementer should never need to
  hold more than the item, its files, and KNOWLEDGE.md in mind.
- **Gate-checkable on its own.** After the item, the gate is green and something
  new demonstrably works. No item may leave the tree red for the next item.

## Ordering

- **Contracts before consumers.** If items share an interface (a type, a schema,
  an API shape), the item that defines it comes first, and the definition is
  written into the item text so later items build against something settled —
  not against a guess.
- **Risk early.** Items touching sensitive zones or unknowns go early, while the
  human is paying the most attention and the least is stacked on top.
- **Each item leaves the repo shippable.** Order so that stopping after any item
  leaves working software.

## ROADMAP.md format

```
# Roadmap — <spec title>

- [ ] 1. <imperative item title>
      files: <expected paths>
      done-when: <the specific acceptance/observable this item satisfies>
      [contract: <frozen interface, if this item defines one>]
      [sensitive: <zone>  ← copies from KNOWLEDGE.md when applicable]
```

`done-when` is the tick's exit test; write it so the implementer cannot
mis-guess the intent. Mark `sensitive:` explicitly — the tick uses it to decide
whether to pay for an independent review.

Hardening items (from init's mechanization proposals, fallow findings, or
`/anakin harden`) use the same format and live in the same list — the factory
does not distinguish building from improving.

## Sanity pass (inline — no critic agent)

Before presenting, re-read the list once and check: items disjoint (no two items
edit the same file for the same reason), contracts defined before used, every
acceptance criterion in SPEC.md covered by some item's done-when, no item
secretly two items. Fix what you find; this two-minute pass is the whole review.
