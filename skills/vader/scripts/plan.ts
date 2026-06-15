// vader plan: the single deterministic fan-out every adapter consumes. planTick turns a recall
// packet into the exact set of slices to run this tick and how many independent verifiers each
// earns, so the parallel and sequential executors are byte-identical in WHAT they run and differ
// only in HOW (wall-clock). Pure: same recall in, same plan out, on every host.

import type { RecallPacket } from './memory.ts'

// Why a slice gets more than one independent verifier. Carried so an adapter can show the
// operator the reason, and so the plan stays auditable rather than a bare number.
export type VoterReason = 'seam' | 'never-ratchet' | 'top-bounce' | 'default'
// `touched` says whether this slice's watched paths changed since the partition stamp. The plan
// always carries EVERY slice (it never silently drops one); an adapter reads `touched` to skip
// unchanged slices when it wants to, with the full set still auditable.
export type TickSlice = { id: string; class: string; voters: number; reason: VoterReason; touched: boolean }

// The deterministic shape of one tick: seam slices run first and alone (they touch shared
// contracts, so a sibling must not race them), then the remaining slices run as parallel
// siblings. Every adapter (Claude Workflow, Pi, the sequential fallback) consumes THIS, so
// the fan-out cannot drift between harnesses.
export type TickPlan = { seamFirst: TickSlice[]; siblings: TickSlice[] }

function votersFor(cls: string, neverRatchet: Set<string>, bounced: Set<string>): { voters: number; reason: VoterReason } {
  // A seam change is the highest-blast-radius edit there is, so it always gets the full panel.
  if (cls === 'seam') return { voters: 3, reason: 'seam' }
  // A never-ratchet class (seam/security/migration) can never earn reduced scrutiny.
  if (neverRatchet.has(cls)) return { voters: 3, reason: 'never-ratchet' }
  // A class that has bounced before is empirically fragile here: verify it harder.
  if (bounced.has(cls)) return { voters: 3, reason: 'top-bounce' }
  return { voters: 1, reason: 'default' }
}

// Pure. Turns a recall packet into the deterministic fan-out plan described in the prose
// recipes, so the parallel and sequential executors are byte-identical in WHAT they run and
// differ only in HOW (wall-clock). Plans over every defined partition slice; an adapter may
// intersect with recall.partition.staleSlices to skip untouched ones.
export function planTick(recall: RecallPacket): TickPlan {
  const neverRatchet = new Set(recall.ratchet.filter((r) => r.neverRatchet).map((r) => r.class))
  const bounced = new Set(recall.topBounces.map((b) => b.class))
  // When the stamp is missing or its commit is gone we cannot compute per-slice staleness, so
  // every slice is treated as touched (verify all rather than skip any). Otherwise only the
  // slices whose watched paths actually changed are touched.
  const allTouched = recall.partition.reason === 'no-stamp' || recall.partition.reason === 'missing-commit'
  const staleIds = new Set(recall.partition.staleSlices.map((s) => s.id))
  const seamFirst: TickSlice[] = []
  const siblings: TickSlice[] = []
  for (const slice of recall.partition.slices) {
    const { voters, reason } = votersFor(slice.class, neverRatchet, bounced)
    const touched = allTouched || staleIds.has(slice.id)
    const tick: TickSlice = { id: slice.id, class: slice.class, voters, reason, touched }
    if (slice.class === 'seam') seamFirst.push(tick)
    else siblings.push(tick)
  }
  return { seamFirst, siblings }
}
