# Vader, assessed from first principles

A fair and critical read of vader as a software factory. Not marketing. The aim is
to say plainly what the design actually buys, where it is strong, where it is weak,
how it fails, and how it would realistically pan out as a shared, opinionated tool.

## The problem it targets

An LLM agent loop has no durable memory of what it meant. Each tick optimizes
locally: make this test pass, satisfy this prompt, close this ticket. Across
hundreds of ticks the architecture decays, because nothing outside the loop holds
the intent fixed. A distinction the author cared about (a temporal point is not a
temporal interval, money is not a float, `common` must not import `etl`) quietly
collapses the first time collapsing it makes a local task easier.

Vader's thesis is narrow and, on its own terms, correct: put the meaning outside
the box. A human writes a `constitution.model` of invariants; `vader gen` compiles
each into the strongest deterministic check the toolchain allows; `vader gate` runs
them and fails on a named invariant id. The agent cannot argue with a failed
compile. That is the whole idea, and it is a good one.

## The three mechanisms, and what each is actually worth

### 1. The compiled constitution (the strong part)

The real move is converting a semantic distinction into a mechanical check. In
TypeScript this has teeth: branded types and `@ts-expect-error` turn a collapsed
distinction into a genuine compile error. Determinism beats judgment for boundary
enforcement, and a compile error beats a paragraph of prompt asking the agent to
please respect the architecture. This is the part of vader that is a genuine
advance over prompt-only approaches.

The honest caveat is the floor. "The strongest check the toolchain allows" varies
enormously. TS with branded types is strong. A dynamically typed target gets a
generated property test or an AST scan, which is weaker, easier to satisfy
hollowly, and more prone to false positives. The headline "invariant-checked
shipped code" is most true for TS and degrades from there. The four kinds are not
equal either: shape and dependency invariants compile to strong static checks;
behavioral and data invariants reduce to tests, and a test only checks the path
you wrote. An agent can satisfy the test and still violate the invariant on an
untested path. The confidence a green gate gives you is inversely proportional to
how behavioral the invariant is.

### 2. The anti-decay model-hash lock (the right structural choice)

The constitution is a protected artifact. Owners can make code fail the gate but
cannot edit `constitution.model.*` or `generated/` to silence it, and the gate
fails closed if the locked hash no longer matches. A run may propose a model change
but never applies one; two human gates bound the whole loop (freeze at conceive,
approve any later change).

This directly addresses the most common way an agent defeats a check: not by
satisfying it but by editing or deleting it. Making the model immutable to the
agent is the correct structural answer. The cost is symmetric and worth naming: the
same lock that prevents decay also prevents agile correction. A stale or wrong
invariant blocks progress until a human opens the gate. That is the right default
for safety, but it means vader is rigid exactly where the constitution is wrong,
and the constitution will sometimes be wrong.

### 3. The evidence ratchet and bounce ledger (reasonable, unproven)

Verifier bounces become calibration data: per-class bounce counts scale the voter
panel next tick (3 voters for a seam, a never-ratchet class, or a class that has
bounced; 1 otherwise), and a ratchet computes how much human gating each slice
class still needs, demoting on any defect. Recall is verify-before-trust; persist
is triage-gated and refuses to end a tick with an untriaged open risk.

The machinery is plausible and the instinct is right: spend verification where
history says it is needed. Two honest limits. First, it calibrates on a tiny
sample (the reference deployment has 14 runs); voter scaling on that few data
points is a heuristic, not a measurement. Second, and more important, the ledger
records detected defects, not actual ones. It optimizes for what verifiers happened
to catch. A class that is quietly fragile but never bounced, because no one tested
the right thing, stays at one voter forever; a class that bounced once early stays
expensive until it accrues clean runs. The loop can entrench its own blind spots.

## Where it genuinely helps

- Long-horizon, multi-tick autonomous work where drift across many runs is the
  real risk, and where a few critical distinctions (money precision, a security
  boundary, dependency direction) can be named and compiled. This is the home turf.
- TypeScript repos, where the compiled checks have the most teeth.
- Teams that will actually invest in authoring a rich constitution. The value is
  proportional to that investment.
- The engineering of the spine itself is clean: one deterministic zero-dep CLI,
  `planTick` as the single source of truth for fan-out so the plan cannot drift
  between harnesses, a thin adapter per host. That is good, auditable design.

## Where it is limited

- The gate is exactly as good as the constitution, and authoring a good
  constitution is the hard, expert, judgment-heavy work. Vader does not reduce that
  work; it front-loads it and demands it be expressible as a check. The distinctions
  that bite in practice are usually the ones nobody anticipated, and vader does
  nothing for an unnamed distinction.
- Verifiers are LLMs judging LLM work. Refute-first, cross-owner, majority vote
  mitigates this but does not remove correlated blind spots: identical models with
  identical prompts share failure modes, and a majority vote over correlated voters
  is weaker than the count suggests. Diverse lenses help; identical refuters mostly
  do not.
- Cost is real. A nine-slice partition with several three-voter classes is roughly
  twenty-plus agent invocations per tick (critic, seam owners, parallel siblings,
  then verifier panels). The expense is highest exactly when the constitution is
  rich enough to be worth it, which is the rare case.
- It assumes disjoint slices and frozen contracts. Additive, partitionable work
  fits well; deep cross-cutting refactors do not. Forcing disjointness pushes the
  hard integration work into the seam slice, which becomes the bottleneck the rest
  of the tick waits on.

## Failure modes, stated plainly

- Hollow satisfaction: a behavioral invariant satisfied by a test that does not
  exercise the real path. The gate goes green; the invariant is violated in
  production. This is the most dangerous mode because it looks like success.
- Over-trust in green: a green gate means "the named invariants hold on the checked
  paths and the toolchain passed." It does not mean correct. The framing invites
  reading it as the latter.
- Constitution rot: the lock that stops the agent from decaying the model also
  stops it from fixing a model that is wrong, until a human intervenes.
- Weak-author ceiling: the quality of the whole system is capped by one human's
  ability to name distinctions. A thin constitution still produces a gate that
  looks rigorous, which is worse than obviously having none.
- Ceremony for its own sake: running the full critic and owner and verifier dance
  on changes that did not need it, paying the cost without the benefit.

## As a shared, opinionated factory

Two things are bolted together under one name. One is a deterministic invariant
gate, which is strong but narrow: it enforces the handful of structural
distinctions you compiled. The other is a style philosophy (deep modules, thin
interfaces, no premature DRY, one pattern per concern, low cognitive load), which
is broad but soft: it lives in the owner mantra and the Ladder, carried by
persuasion in prompts, the same as any other prompt. The compiled gate does not
enforce the values, and the values are most of what makes the code good. An honest
description keeps these separate rather than letting the rigor of the first lend
borrowed authority to the second.

Adoption is bimodal. The upfront cost is writing a real `constitution.model` for
your repo, and most teams will either skip it or write a thin one, in which case
the tool's value approaches zero while its ceremony does not. For the teams that do
invest, on a long-horizon autonomous build with a few genuinely critical
expressible invariants, the payoff is real. That is a narrower niche than "a
factory for everyone," and selling it as the wider thing would set most users up to
get the cost without the benefit.

The portability claim deserves the same honesty. `planTick` plus a documented
sequential fallback is good design, and the shared plan means harnesses cannot
disagree on what runs. But only the Claude Code path is exercised end to end; the
Pi, Codex, and Hermes adapters are unit-tested against the shared plan and rely on
the operator to validate them live. "Works across every agent" is a sound design
intention, not yet a validated fact, and should be stated as the former.

## Verdict

The central idea, compile the distinctions you care about into a gate the agent
cannot silence and lock that gate against the agent, is genuinely good and answers
a real, specific failure of long-horizon agent loops. Vader is strongest exactly
where software is most structural and weakest exactly where software is hardest:
behavioral correctness and the distinction nobody named. It does not make agents
correct. It makes a named set of architectural decisions durable across many ticks,
which is a real but bounded win. The surrounding ratchet and voter machinery is
reasonable but unproven on small samples and measures detected rather than actual
defects.

Sold honestly, as a durability harness for the invariants you can express, vader is
a sharp tool with a clear niche and clean engineering. Sold as a factory that ships
correct software, it overpromises. The difference between those two pitches is the
difference between a tool people trust after a year and one they abandon after the
first green gate that shipped a bug.
