// vader memory: what the factory remembers across ticks so an agent rehydrates instead of
// re-deriving. The run report (the single persist input) and its validation; triage of open
// risks; the evidence-derived ratchet computed from the ledger; the triage-gated, crash-safe
// persist; and the verify-before-trust recall packet. All of it reads and writes the state
// record in core; recall also consults the model (is it present?) and git (what is stale?).

import { existsSync, readFileSync, appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  VaderError,
  paths,
  loadState,
  saveState,
  readLedger,
  obj,
  str,
  arr,
  oneOf,
  modelChangeOf,
  type State,
  type Risk,
  type ModelChange,
  type PartitionSlice,
  type RoadmapStatus,
  type RoadmapItem,
  type Mode,
  type Gate,
  type Severity,
  type TriageAction,
  type Staleness,
  type LedgerLine,
  type RunLine,
} from './core.ts'
import { readModel } from './model.ts'
import { git, staleness, changedSince, underWatch, commitExists } from './git.ts'

// ---------- run report (single persist input, build + review) ----------

export type Bounce = { ac: string; reason: string }
export type SliceResult = {
  id: string
  class: string
  owner: string
  verdict: 'accept' | 'bounce'
  bounces: Bounce[]
}

export type RunReport = {
  run: { id: string; mode: Mode; spec: string; commitRange: string; gate: Gate }
  itemId?: string
  slices: SliceResult[]
  risks: {
    new: { id: string; desc: string; owner: string; severity: Severity }[]
    dispositions: { riskId: string; action: TriageAction; reason: string }[]
  }
  decisions: { id: string; title: string; body: string; supersedes?: string }[]
  conventions: { id: string; rule: string }[]
  stamps?: {
    grounding?: { commit: string; watch: string[] }
    partition?: { commit: string; slices: PartitionSlice[] }
  }
  modelChange?: ModelChange
}

export type RatchetClass = {
  class: string
  level: number
  eligible: number
  consecutiveClean: number
  neverRatchet: boolean
}

const LEVELS = { L1_CLEAN_RUNS: 2, L2_CLEAN_RUNS: 3 }

// ---------- run report validation (hand-rolled, named paths in every error) ----------

export function validateReport(input: unknown): RunReport {
  const r = obj(input, 'report')
  const run = obj(r.run, 'run')
  const report: RunReport = {
    run: {
      id: str(run.id, 'run.id'),
      mode: oneOf(run.mode, 'run.mode', ['build', 'review'] as const),
      spec: str(run.spec, 'run.spec'),
      commitRange: str(run.commitRange, 'run.commitRange'),
      gate: oneOf(run.gate, 'run.gate', ['green', 'residual', 'failed'] as const),
    },
    slices: arr(r.slices, 'slices').map((s, i) => {
      const slice = obj(s, `slices[${i}]`)
      return {
        id: str(slice.id, `slices[${i}].id`),
        class: str(slice.class, `slices[${i}].class`),
        owner: str(slice.owner, `slices[${i}].owner`),
        verdict: oneOf(slice.verdict, `slices[${i}].verdict`, ['accept', 'bounce'] as const),
        bounces: arr(slice.bounces, `slices[${i}].bounces`).map((b, j) => {
          const bounce = obj(b, `slices[${i}].bounces[${j}]`)
          return {
            ac: str(bounce.ac, `slices[${i}].bounces[${j}].ac`),
            reason: str(bounce.reason, `slices[${i}].bounces[${j}].reason`),
          }
        }),
      }
    }),
    risks: (() => {
      const risks = obj(r.risks, 'risks')
      return {
        new: arr(risks.new, 'risks.new').map((x, i) => {
          const risk = obj(x, `risks.new[${i}]`)
          return {
            id: str(risk.id, `risks.new[${i}].id`),
            desc: str(risk.desc, `risks.new[${i}].desc`),
            owner: str(risk.owner, `risks.new[${i}].owner`),
            severity: oneOf(risk.severity, `risks.new[${i}].severity`, ['low', 'medium', 'high'] as const),
          }
        }),
        dispositions: arr(risks.dispositions, 'risks.dispositions').map((x, i) => {
          const d = obj(x, `risks.dispositions[${i}]`)
          return {
            riskId: str(d.riskId, `risks.dispositions[${i}].riskId`),
            action: oneOf(d.action, `risks.dispositions[${i}].action`, ['finding', 'defer', 'close'] as const),
            reason: str(d.reason, `risks.dispositions[${i}].reason`),
          }
        }),
      }
    })(),
    decisions: arr(r.decisions, 'decisions').map((x, i) => {
      const d = obj(x, `decisions[${i}]`)
      const out: RunReport['decisions'][number] = {
        id: str(d.id, `decisions[${i}].id`),
        title: str(d.title, `decisions[${i}].title`),
        body: str(d.body, `decisions[${i}].body`),
      }
      if (d.supersedes !== undefined) out.supersedes = str(d.supersedes, `decisions[${i}].supersedes`)
      return out
    }),
    conventions: arr(r.conventions, 'conventions').map((x, i) => {
      const c = obj(x, `conventions[${i}]`)
      return { id: str(c.id, `conventions[${i}].id`), rule: str(c.rule, `conventions[${i}].rule`) }
    }),
  }
  if (r.itemId !== undefined) report.itemId = str(r.itemId, 'itemId')
  if (r.modelChange !== undefined) report.modelChange = modelChangeOf(r.modelChange, 'modelChange')
  if (r.stamps !== undefined) {
    const stamps = obj(r.stamps, 'stamps')
    report.stamps = {}
    if (stamps.grounding !== undefined) {
      const g = obj(stamps.grounding, 'stamps.grounding')
      report.stamps.grounding = {
        commit: str(g.commit, 'stamps.grounding.commit'),
        watch: arr(g.watch, 'stamps.grounding.watch').map((w, i) => str(w, `stamps.grounding.watch[${i}]`)),
      }
    }
    if (stamps.partition !== undefined) {
      const pt = obj(stamps.partition, 'stamps.partition')
      report.stamps.partition = {
        commit: str(pt.commit, 'stamps.partition.commit'),
        slices: arr(pt.slices, 'stamps.partition.slices').map((s, i) => {
          const slice = obj(s, `stamps.partition.slices[${i}]`)
          return {
            id: str(slice.id, `stamps.partition.slices[${i}].id`),
            class: str(slice.class, `stamps.partition.slices[${i}].class`),
            paths: arr(slice.paths, `stamps.partition.slices[${i}].paths`).map((x, j) =>
              str(x, `stamps.partition.slices[${i}].paths[${j}]`),
            ),
          }
        }),
      }
    }
  }
  return report
}

// ---------- triage ----------

export function cmdTriage(
  root: string,
  riskId: string,
  action: TriageAction,
  reason: string,
): { pending: State['pendingTriage'] } {
  const state = loadState(root)
  const risk = state.risks.find((r) => r.id === riskId && r.status === 'open')
  if (risk === undefined) throw new VaderError(`unknown risk or not open: ${riskId}`)
  if (reason === '') throw new VaderError('a triage disposition requires a reason')
  state.pendingTriage = state.pendingTriage.filter((t) => t.riskId !== riskId)
  state.pendingTriage.push({ riskId, action, reason })
  saveState(root, state)
  return { pending: state.pendingTriage }
}

// ---------- ratchet (evidence-derived from the ledger) ----------

function classClean(line: RunLine, cls: string): boolean | null {
  const slices = line.slices.filter((s) => s.class === cls)
  if (slices.length === 0) return null // run did not touch the class: no evidence either way
  return line.gate === 'green' && slices.every((s) => s.verdict === 'accept')
}

function consecutiveClean(ledger: LedgerLine[], cls: string): number {
  const runs = ledger.filter((l): l is RunLine => l.type === 'run')
  let count = 0
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]
    if (run === undefined) break
    const clean = classClean(run, cls)
    if (clean === null) continue
    if (!clean) break
    count++
  }
  return count
}

function computeRatchet(state: State, ledger: LedgerLine[], filter?: string): RatchetClass[] {
  const seen = new Set<string>()
  for (const line of ledger) {
    if (line.type === 'run') for (const s of line.slices) seen.add(s.class)
  }
  for (const cls of Object.keys(state.ratchet.grants)) seen.add(cls)
  const classes = filter !== undefined ? [filter] : [...seen].sort()
  return classes.map((cls) => {
    const neverRatchet = state.ratchet.neverRatchet.includes(cls)
    const clean = consecutiveClean(ledger, cls)
    const eligible = neverRatchet ? 0 : clean >= LEVELS.L2_CLEAN_RUNS ? 2 : clean >= LEVELS.L1_CLEAN_RUNS ? 1 : 0
    return { class: cls, level: state.ratchet.grants[cls]?.level ?? 0, eligible, consecutiveClean: clean, neverRatchet }
  })
}

export function cmdRatchet(
  root: string,
  cls?: string,
  opts?: { grant: number; approvedBy: string },
): { classes: RatchetClass[] } {
  const state = loadState(root)
  const ledger = readLedger(root)
  if (opts !== undefined) {
    if (cls === undefined) throw new VaderError('grant requires a class')
    if (opts.approvedBy === '') throw new VaderError('grant requires an approver (--approved-by)')
    const computed = computeRatchet(state, ledger, cls)[0]
    if (computed === undefined || computed.neverRatchet) throw new VaderError(`never-ratchet class: ${cls}`)
    if (opts.grant > computed.eligible) {
      throw new VaderError(
        `class ${cls} is not eligible for L${opts.grant} (eligible: L${computed.eligible}, consecutive clean runs: ${computed.consecutiveClean})`,
      )
    }
    state.ratchet.grants[cls] = { level: opts.grant, approvedBy: opts.approvedBy, date: new Date().toISOString() }
    saveState(root, state)
  }
  return { classes: computeRatchet(state, ledger, cls) }
}

// ---------- persist (build + review, triage-gated, anti-decay aware) ----------

export type PersistResult = {
  run: string
  item: { id: string; status: RoadmapStatus } | null
  modelChangeParked: boolean
  risksClosed: string[]
  risksDeferred: string[]
  risksNew: string[]
  bounces: number
  demoted: string[]
  stampsAdvanced: string[]
  debt: number
}

// The structural-decay number recorded on every run-line. It counts only UNAMBIGUOUS debt units,
// each computed cheaply from an artifact the persist already touches and each one the constitution
// already forbids growing without a routed model change:
//   runtimeDeps   dependencies in package.json (devDependencies excluded: tooling is not runtime)
//   topLevelDirs  non-dotfile top-level directories (node_modules excluded: it is installed deps)
//   escapeHatches rawCheck invariants in the model (each earns none of the gold-path guarantees)
// Deliberately NOT counted: export-surface size, file size, LOC. Those grow during healthy active
// development, so blocking on them would punish a clean module for being worked on. illegalEdges
// and cycles are already hard-zeroed on a green tick by the dependency scanner and fallow, so they
// are not summed here. A .ts-only model (no JSON machine-truth) contributes zero escape hatches.
export function computeDebt(root: string): number {
  return runtimeDepCount(root) + topLevelDirCount(root) + escapeHatchCount(root)
}

function runtimeDepCount(root: string): number {
  const fp = join(root, 'package.json')
  if (!existsSync(fp)) return 0
  try {
    const pkg: unknown = JSON.parse(readFileSync(fp, 'utf8'))
    const deps = typeof pkg === 'object' && pkg !== null ? (pkg as Record<string, unknown>)['dependencies'] : undefined
    return typeof deps === 'object' && deps !== null && !Array.isArray(deps) ? Object.keys(deps).length : 0
  } catch {
    return 0
  }
}

// Top-level source directories. "No new top-level directory" is a rule about the tracked source
// tree, so we count git-tracked top-level dirs and ignore untracked build output (dist/, coverage/,
// out/, ...): counting the raw filesystem would make debt a function of transient, gitignored state
// and refuse an otherwise-clean tick the moment a build ran. Outside a git repo (or before the first
// commit) we fall back to a filesystem read that still excludes dotfiles and node_modules.
function topLevelDirCount(root: string): number {
  const tracked = trackedTopLevelDirs(root)
  if (tracked !== null) return tracked
  let n = 0
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') n++
  }
  return n
}

function trackedTopLevelDirs(root: string): number | null {
  let out: string
  try {
    // NUL-separated so a path with a space or newline cannot merge two entries into one.
    out = git(root, ['ls-files', '-z'])
  } catch {
    return null // not a git repo: the caller falls back to a filesystem read
  }
  const dirs = new Set<string>()
  for (const f of out.split('\0')) {
    const slash = f.indexOf('/')
    if (slash > 0) dirs.add(f.slice(0, slash))
  }
  return dirs.size
}

function escapeHatchCount(root: string): number {
  const fp = paths(root).modelJson
  if (!existsSync(fp)) return 0
  try {
    const model: unknown = JSON.parse(readFileSync(fp, 'utf8'))
    const invs = typeof model === 'object' && model !== null ? (model as Record<string, unknown>)['invariants'] : undefined
    if (!Array.isArray(invs)) return 0
    return invs.filter((i) => {
      const check = typeof i === 'object' && i !== null ? (i as Record<string, unknown>)['check'] : undefined
      return typeof check === 'object' && check !== null && 'rawCheck' in (check as Record<string, unknown>)
    }).length
  } catch {
    return 0
  }
}

export function cmdPersist(root: string, reportInput: RunReport | string): PersistResult {
  const state = loadState(root)
  const ledger = readLedger(root)
  const raw: unknown = typeof reportInput === 'string' ? JSON.parse(readFileSync(reportInput, 'utf8')) : reportInput
  const report = validateReport(raw)
  const runId = report.run.id

  // -- validate everything before writing anything --
  if (ledger.some((l) => l.type === 'run' && l.id === runId)) throw new VaderError(`duplicate run id: ${runId}`)

  const item =
    report.itemId !== undefined ? state.roadmap.find((r) => r.id === report.itemId) : undefined
  if (report.itemId !== undefined && item === undefined)
    throw new VaderError(`unknown roadmap item ${report.itemId}`)

  const dispositions = new Map<string, { action: TriageAction; reason: string }>()
  for (const t of state.pendingTriage) dispositions.set(t.riskId, { action: t.action, reason: t.reason })
  for (const d of report.risks.dispositions) dispositions.set(d.riskId, { action: d.action, reason: d.reason }) // report wins

  for (const riskId of dispositions.keys()) {
    if (!state.risks.some((r) => r.id === riskId && r.status === 'open'))
      throw new VaderError(`unknown risk or not open: ${riskId}`)
  }
  const undispositioned = state.risks.filter((r) => r.status === 'open' && !dispositions.has(r.id)).map((r) => r.id)
  if (undispositioned.length > 0) {
    throw new VaderError(
      `undispositioned open risks: ${undispositioned.join(', ')}. Triage every open risk (finding, defer, or close) before persist.`,
    )
  }
  for (const risk of report.risks.new) {
    const existing = state.risks.find((r) => r.id === risk.id)
    // a risk already carried by THIS run is a safe re-persist (crash recovery), not a conflict.
    if (existing !== undefined && existing.originRun !== runId) throw new VaderError(`duplicate risk id: ${risk.id}`)
  }
  const knownDecisions = new Set(state.decisions)
  for (const d of report.decisions) {
    if (d.supersedes !== undefined && !knownDecisions.has(d.supersedes))
      throw new VaderError(`unknown decision: ${d.supersedes} (supersedes target was never recorded)`)
    knownDecisions.add(d.id)
  }

  // -- apply in memory --
  const risksClosed: string[] = []
  const risksDeferred: string[] = []
  for (const [riskId, d] of dispositions) {
    const risk = state.risks.find((r) => r.id === riskId)
    if (risk === undefined) continue
    if (risk.history.some((h) => h.run === runId)) continue // already applied: idempotent re-persist
    risk.history.push({ run: runId, action: d.action, reason: d.reason })
    if (d.action === 'defer') {
      risksDeferred.push(riskId)
    } else {
      risk.status = 'closed'
      risksClosed.push(riskId)
    }
  }
  state.pendingTriage = []
  for (const risk of report.risks.new) {
    if (!state.risks.some((r) => r.id === risk.id))
      state.risks.push({ ...risk, originRun: runId, status: 'open', history: [] })
  }
  for (const d of report.decisions) if (!state.decisions.includes(d.id)) state.decisions.push(d.id)

  // anti-decay: a run may PROPOSE a model change, never apply it. Parking blocks the item.
  const modelChangeParked = report.modelChange !== undefined
  if (report.modelChange !== undefined) state.pendingModelChange = report.modelChange

  // structural-debt ratchet: this tick's debt must not exceed the last run-line's, so integrity is
  // non-decreasing per tick while a tick that holds or lowers it (delete an escape hatch, drop a
  // dep) is free. The only way to raise the baseline is a routed model change, which is exactly
  // the human-gated escape valve for a legitimate new dependency or top-level directory. Checked
  // here, still before any disk write, so a refused tick leaves nothing partially persisted.
  const debt = computeDebt(root)
  const prevRun = [...ledger].reverse().find((l): l is RunLine => l.type === 'run')
  // The first tick has no predecessor to ratchet against, so it records the repo's existing debt as
  // the baseline. Comparing against an implicit zero would refuse the first persist on any real repo
  // (which already carries deps and top-level dirs) and break the "adopt Vader on an existing repo"
  // flow. From the second tick on, debt is non-increasing unless a routed model change lifts it.
  if (prevRun !== undefined && debt > prevRun.debt && !modelChangeParked) {
    throw new VaderError(
      `structural debt would rise from ${prevRun.debt} to ${debt} (runtime deps + top-level dirs + escape-hatch invariants). ` +
        `Remove the added debt, or route a model change to raise the baseline.`,
    )
  }

  // build-mode roadmap item: green and unblocked -> done; otherwise blocked.
  if (item !== undefined) {
    item.status = !modelChangeParked && report.run.gate === 'green' ? 'done' : 'blocked'
  }

  // ratchet demotion: any bounce or non-green gate in a class zeroes its grant
  const demoted: string[] = []
  const runClasses = new Set(report.slices.map((s) => s.class))
  for (const cls of runClasses) {
    const slices = report.slices.filter((s) => s.class === cls)
    const dirty = report.run.gate !== 'green' || slices.some((s) => s.verdict === 'bounce' || s.bounces.length > 0)
    const grant = state.ratchet.grants[cls]
    if (dirty && grant !== undefined && grant.level > 0) {
      grant.level = 0
      grant.note = `auto-demoted by run ${runId}`
      demoted.push(cls)
    }
  }

  const stampsAdvanced: string[] = []
  if (report.stamps?.grounding !== undefined) {
    state.grounding = { commit: report.stamps.grounding.commit, watch: report.stamps.grounding.watch }
    stampsAdvanced.push('grounding')
  }
  if (report.stamps?.partition !== undefined) {
    state.partition = { commit: report.stamps.partition.commit, slices: report.stamps.partition.slices }
    stampsAdvanced.push('partition')
  }

  // -- write order matters for crash safety. The LEDGER run-line is the commit marker the
  // dedup guard keys on, so it is written LAST; state (atomic rename) and the prose appends
  // come first and are all idempotent (guarded above / by marker below). A crash before the
  // ledger append leaves a re-runnable run, never a bricked one. --
  const p = paths(root)
  const date = new Date().toISOString()

  saveState(root, state)

  const existingDecisions = existsSync(p.decisions) ? readFileSync(p.decisions, 'utf8') : ''
  for (const d of report.decisions) {
    if (existingDecisions.includes(`\n## ${d.id}: `)) continue // idempotent re-persist
    const supersedes = d.supersedes !== undefined ? `\nSupersedes: ${d.supersedes}` : ''
    appendFileSync(p.decisions, `\n## ${d.id}: ${d.title}\n\nStatus: active (run: ${runId}, ${date})${supersedes}\n\n${d.body}\n`)
  }
  const existingConventions = existsSync(p.conventions) ? readFileSync(p.conventions, 'utf8') : ''
  for (const c of report.conventions) {
    if (existingConventions.includes(`\n- ${c.id} (run: ${runId}): `)) continue // idempotent re-persist
    appendFileSync(p.conventions, `\n- ${c.id} (run: ${runId}): ${c.rule}\n`)
  }

  const lines: LedgerLine[] = [
    {
      type: 'run',
      id: runId,
      date,
      mode: report.run.mode,
      spec: report.run.spec,
      commitRange: report.run.commitRange,
      gate: report.run.gate,
      slices: report.slices.map((s) => ({ id: s.id, class: s.class, verdict: s.verdict })),
      debt,
    },
  ]
  let bounces = 0
  for (const s of report.slices) {
    for (const b of s.bounces) {
      bounces++
      lines.push({ type: 'bounce', run: runId, slice: s.id, class: s.class, ac: b.ac, reason: b.reason })
    }
  }
  appendFileSync(p.ledger, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return {
    run: runId,
    item: item !== undefined ? { id: item.id, status: item.status } : null,
    modelChangeParked,
    risksClosed,
    risksDeferred,
    risksNew: report.risks.new.map((r) => r.id),
    bounces,
    demoted,
    stampsAdvanced,
    debt,
  }
}

// ---------- recall (verify-before-trust rehydration packet) ----------

export type RecallPacket = {
  modelHash: string | null
  modelOk: boolean
  invariantCount: number
  roadmap: { id: string; status: RoadmapStatus }[]
  nextItem: RoadmapItem | null
  pendingModelChange: ModelChange | null
  grounding: Staleness
  partition: { commit: string | null; stale: boolean; reason: Staleness['reason']; slices: PartitionSlice[]; staleSlices: { id: string; changed: string[] }[] }
  openRisks: Risk[]
  mustTriage: Risk[]
  pendingTriage: State['pendingTriage']
  decisions: { file: string; count: number }
  conventions: { file: string }
  topBounces: { class: string; reason: string; count: number }[]
  ratchet: RatchetClass[]
  lastRun: { id: string; date: string; mode: Mode; gate: Gate; commitRange: string } | null
  runCount: number
}

export async function cmdRecall(root: string): Promise<RecallPacket> {
  const state = loadState(root)
  const ledger = readLedger(root)

  let modelOk = false
  let invariantCount = 0
  try {
    const { model } = await readModel(root)
    modelOk = true
    invariantCount = model.invariants.length
  } catch {
    // model may be absent before P0; recall still works so the loop can bootstrap.
  }

  // Partition staleness, computing changedSince exactly once and reusing it per slice (a large
  // repo's diff is not free). commit === null is 'no-stamp'; a vanished commit is 'missing-commit';
  // otherwise a slice is stale when one of its watched paths shows up in the diff.
  const staleSlices: { id: string; changed: string[] }[] = []
  let partitionReason: Staleness['reason'] = null
  if (state.partition.commit === null) {
    partitionReason = 'no-stamp'
  } else if (!commitExists(root, state.partition.commit)) {
    partitionReason = 'missing-commit'
  } else {
    const changed = changedSince(root, state.partition.commit)
    for (const slice of state.partition.slices) {
      const hits = changed.filter((f) => underWatch(f, slice.paths))
      if (hits.length > 0) staleSlices.push({ id: slice.id, changed: hits })
    }
    if (staleSlices.length > 0) partitionReason = 'watch-touched'
  }
  const partitionStale = partitionReason !== null

  // Key on the structured [class, reason] pair so a multi-word reason survives intact AND two
  // pairs that would flatten to the same space-joined string ('a'+'b c' vs 'a b'+'c') stay
  // distinct buckets.
  const bounceCounts = new Map<string, { class: string; reason: string; count: number }>()
  for (const line of ledger) {
    if (line.type !== 'bounce') continue
    const key = JSON.stringify([line.class, line.reason])
    const prev = bounceCounts.get(key)
    if (prev === undefined) bounceCounts.set(key, { class: line.class, reason: line.reason, count: 1 })
    else prev.count++
  }
  const topBounces = [...bounceCounts.values()].sort((a, b) => b.count - a.count).slice(0, 10)

  const runs = ledger.filter((l): l is RunLine => l.type === 'run')
  const last = runs[runs.length - 1]
  const next = state.roadmap.find((r) => r.status === 'pending') ?? null
  const openRisks = state.risks.filter((r) => r.status === 'open')

  return {
    modelHash: state.modelHash,
    modelOk,
    invariantCount,
    roadmap: state.roadmap.map((r) => ({ id: r.id, status: r.status })),
    nextItem: next,
    pendingModelChange: state.pendingModelChange,
    grounding: staleness(root, state.grounding.commit, state.grounding.watch),
    partition: {
      commit: state.partition.commit,
      stale: partitionStale,
      reason: partitionReason,
      slices: state.partition.slices,
      staleSlices,
    },
    // mustTriage is intentionally identical to openRisks today (every open risk blocks the
    // next persist). It is named separately so the gating list can narrow later without churn.
    openRisks,
    mustTriage: openRisks,
    pendingTriage: state.pendingTriage,
    decisions: { file: '.vader/DECISIONS.md', count: state.decisions.length },
    conventions: { file: '.vader/CONVENTIONS.md' },
    topBounces,
    ratchet: computeRatchet(state, ledger),
    lastRun: last !== undefined ? { id: last.id, date: last.date, mode: last.mode, gate: last.gate, commitRange: last.commitRange } : null,
    runCount: runs.length,
  }
}
