#!/usr/bin/env bun
// galaxy: the deterministic memory layer of the anakin-galaxy software factory.
// One module, five commands: init, recall, triage, persist, ratchet.
// The CLI owns .galaxy/state.json and .galaxy/LEDGER.jsonl; the session owns the
// prose files and runs/<id>/. Agents read factory state, they never write it.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// ---------- types ----------

export type Gate = 'green' | 'residual' | 'failed'
export type Mode = 'build' | 'review'
export type Severity = 'low' | 'medium' | 'high'
export type TriageAction = 'finding' | 'defer' | 'close'

export type Bounce = { ac: string, reason: string }
export type SliceResult = { id: string, class: string, owner: string, verdict: 'accept' | 'bounce', bounces: Bounce[] }
export type PartitionSlice = { id: string, class: string, paths: string[] }

export type RunReport = {
  run: { id: string, mode: Mode, spec: string, commitRange: string, gate: Gate }
  slices: SliceResult[]
  risks: {
    new: { id: string, desc: string, owner: string, severity: Severity }[]
    dispositions: { riskId: string, action: TriageAction, reason: string }[]
  }
  decisions: { id: string, title: string, body: string, supersedes?: string }[]
  conventions: { id: string, rule: string }[]
  stamps?: {
    grounding?: { commit: string, watch: string[] }
    partition?: { commit: string, slices: PartitionSlice[] }
  }
}

export type Risk = {
  id: string, desc: string, owner: string, severity: Severity, originRun: string,
  status: 'open' | 'closed',
  history: { run: string, action: TriageAction, reason: string }[]
}

export type State = {
  version: 1
  grounding: { commit: string | null, watch: string[] }
  partition: { commit: string | null, slices: PartitionSlice[] }
  risks: Risk[]
  pendingTriage: { riskId: string, action: TriageAction, reason: string }[]
  decisions: string[]
  ratchet: {
    grants: Record<string, { level: number, approvedBy: string, date: string, note?: string }>
    neverRatchet: string[]
  }
}

type RunLine = { type: 'run', id: string, date: string, mode: Mode, spec: string, commitRange: string, gate: Gate, slices: { id: string, class: string, verdict: 'accept' | 'bounce' }[] }
type BounceLine = { type: 'bounce', run: string, slice: string, class: string, ac: string, reason: string }
type LedgerLine = RunLine | BounceLine

export type Staleness = { commit: string | null, stale: boolean, reason: 'no-stamp' | 'missing-commit' | 'watch-touched' | null, changed: string[] }

export type RatchetClass = { class: string, level: number, eligible: number, consecutiveClean: number, neverRatchet: boolean }

export class GalaxyError extends Error {}

const NEVER_RATCHET_DEFAULT = ['seam', 'security', 'migration']
const LEVELS = { L1_CLEAN_RUNS: 2, L2_CLEAN_RUNS: 3 }

// ---------- filesystem layout ----------

function paths(root: string) {
  const dir = join(root, '.galaxy')
  return {
    dir,
    state: join(dir, 'state.json'),
    ledger: join(dir, 'LEDGER.jsonl'),
    grounding: join(dir, 'GROUNDING.md'),
    decisions: join(dir, 'DECISIONS.md'),
    conventions: join(dir, 'CONVENTIONS.md'),
    runs: join(dir, 'runs'),
  }
}

function defaultState(): State {
  return {
    version: 1,
    grounding: { commit: null, watch: [] },
    partition: { commit: null, slices: [] },
    risks: [],
    pendingTriage: [],
    decisions: [],
    ratchet: { grants: {}, neverRatchet: [...NEVER_RATCHET_DEFAULT] },
  }
}

export function loadState(root: string): State {
  const p = paths(root)
  if (!existsSync(p.state)) throw new GalaxyError(`no factory state at ${p.state}; run "galaxy init" first`)
  return JSON.parse(readFileSync(p.state, 'utf8')) as State
}

function saveState(root: string, state: State): void {
  const p = paths(root)
  const tmp = `${p.state}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  renameSync(tmp, p.state)
}

function readLedger(root: string): LedgerLine[] {
  const raw = readFileSync(paths(root).ledger, 'utf8').trim()
  if (raw === '') return []
  return raw.split('\n').map((l) => JSON.parse(l) as LedgerLine)
}

// ---------- git ----------

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function commitExists(root: string, commit: string): boolean {
  try {
    git(root, ['cat-file', '-e', `${commit}^{commit}`])
    return true
  } catch {
    return false
  }
}

function changedSince(root: string, commit: string): string[] {
  const out = git(root, ['diff', '--name-only', `${commit}..HEAD`])
  return out === '' ? [] : out.split('\n')
}

function staleness(root: string, commit: string | null, watch: string[]): Staleness {
  if (commit === null) return { commit, stale: true, reason: 'no-stamp', changed: [] }
  if (!commitExists(root, commit)) return { commit, stale: true, reason: 'missing-commit', changed: [] }
  const changed = changedSince(root, commit).filter((f) => watch.some((w) => f.startsWith(w)))
  return changed.length > 0
    ? { commit, stale: true, reason: 'watch-touched', changed }
    : { commit, stale: false, reason: null, changed: [] }
}

// ---------- report validation (hand-rolled, named paths in every error) ----------

function fail(path: string, msg: string): never {
  throw new GalaxyError(`invalid report: ${path} ${msg}`)
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object')
  return value as Record<string, unknown>
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') fail(path, 'must be a non-empty string')
  return value
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  return value
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

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
          return { ac: str(bounce.ac, `slices[${i}].bounces[${j}].ac`), reason: str(bounce.reason, `slices[${i}].bounces[${j}].reason`) }
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
      const p = obj(stamps.partition, 'stamps.partition')
      report.stamps.partition = {
        commit: str(p.commit, 'stamps.partition.commit'),
        slices: arr(p.slices, 'stamps.partition.slices').map((s, i) => {
          const slice = obj(s, `stamps.partition.slices[${i}]`)
          return {
            id: str(slice.id, `stamps.partition.slices[${i}].id`),
            class: str(slice.class, `stamps.partition.slices[${i}].class`),
            paths: arr(slice.paths, `stamps.partition.slices[${i}].paths`).map((x, j) => str(x, `stamps.partition.slices[${i}].paths[${j}]`)),
          }
        }),
      }
    }
  }
  return report
}

// ---------- init ----------

const GROUNDING_STUB = `# Grounding (stable layer)

Written by the session, stamped via state.json. Refresh only when recall flags it stale.
Sections: glossary, module graph, integration seams, cross-cutting conventions, the mantra.
`

export function cmdInit(root: string): { alreadyInitialized: boolean, dir: string } {
  const p = paths(root)
  if (existsSync(p.state)) return { alreadyInitialized: true, dir: p.dir }
  mkdirSync(p.runs, { recursive: true })
  writeFileSync(p.ledger, '')
  writeFileSync(p.grounding, GROUNDING_STUB)
  writeFileSync(p.decisions, '# Decisions\n\nAppend-only ADR log, written by galaxy persist.\n')
  writeFileSync(p.conventions, '# Conventions\n\nFrozen conventions with origin run, written by galaxy persist.\n')
  saveState(root, defaultState())
  return { alreadyInitialized: false, dir: p.dir }
}

// ---------- triage ----------

export function cmdTriage(root: string, riskId: string, action: TriageAction, reason: string): { pending: State['pendingTriage'] } {
  const state = loadState(root)
  const risk = state.risks.find((r) => r.id === riskId && r.status === 'open')
  if (risk === undefined) throw new GalaxyError(`unknown risk or not open: ${riskId}`)
  if (reason === '') throw new GalaxyError('a triage disposition requires a reason')
  state.pendingTriage = state.pendingTriage.filter((t) => t.riskId !== riskId)
  state.pendingTriage.push({ riskId, action, reason })
  saveState(root, state)
  return { pending: state.pendingTriage }
}

// ---------- ratchet ----------

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

export function cmdRatchet(root: string, cls?: string, opts?: { grant: number, approvedBy: string }): { classes: RatchetClass[] } {
  const state = loadState(root)
  const ledger = readLedger(root)
  if (opts !== undefined) {
    if (cls === undefined) throw new GalaxyError('grant requires a class')
    if (opts.approvedBy === '') throw new GalaxyError('grant requires an approver (--approved-by)')
    const computed = computeRatchet(state, ledger, cls)[0]
    if (computed === undefined || computed.neverRatchet) throw new GalaxyError(`never-ratchet class: ${cls}`)
    if (opts.grant > computed.eligible) {
      throw new GalaxyError(`class ${cls} is not eligible for L${opts.grant} (eligible: L${computed.eligible}, consecutive clean runs: ${computed.consecutiveClean})`)
    }
    state.ratchet.grants[cls] = { level: opts.grant, approvedBy: opts.approvedBy, date: new Date().toISOString() }
    saveState(root, state)
  }
  return { classes: computeRatchet(state, ledger, cls) }
}

// ---------- persist ----------

export type PersistResult = {
  run: string
  risksClosed: string[]
  risksDeferred: string[]
  risksNew: string[]
  bounces: number
  demoted: string[]
  stampsAdvanced: string[]
}

export function cmdPersist(root: string, reportInput: RunReport | string): PersistResult {
  const state = loadState(root)
  const ledger = readLedger(root)
  const raw: unknown = typeof reportInput === 'string' ? JSON.parse(readFileSync(reportInput, 'utf8')) : reportInput
  const report = validateReport(raw)
  const runId = report.run.id

  // -- validate everything before writing anything --
  if (ledger.some((l) => l.type === 'run' && l.id === runId)) throw new GalaxyError(`duplicate run id: ${runId}`)

  const dispositions = new Map<string, { action: TriageAction, reason: string }>()
  for (const t of state.pendingTriage) dispositions.set(t.riskId, { action: t.action, reason: t.reason })
  for (const d of report.risks.dispositions) dispositions.set(d.riskId, { action: d.action, reason: d.reason }) // report wins

  for (const riskId of dispositions.keys()) {
    if (!state.risks.some((r) => r.id === riskId && r.status === 'open')) throw new GalaxyError(`unknown risk or not open: ${riskId}`)
  }
  const undispositioned = state.risks.filter((r) => r.status === 'open' && !dispositions.has(r.id)).map((r) => r.id)
  if (undispositioned.length > 0) {
    throw new GalaxyError(`undispositioned open risks: ${undispositioned.join(', ')}. Triage every open risk (finding, defer, or close) before persist.`)
  }
  for (const risk of report.risks.new) {
    if (state.risks.some((r) => r.id === risk.id)) throw new GalaxyError(`duplicate risk id: ${risk.id}`)
  }
  const knownDecisions = new Set(state.decisions)
  for (const d of report.decisions) {
    if (d.supersedes !== undefined && !knownDecisions.has(d.supersedes)) throw new GalaxyError(`unknown decision: ${d.supersedes} (supersedes target was never recorded)`)
    knownDecisions.add(d.id)
  }

  // -- apply in memory --
  const risksClosed: string[] = []
  const risksDeferred: string[] = []
  for (const [riskId, d] of dispositions) {
    const risk = state.risks.find((r) => r.id === riskId)
    if (risk === undefined) continue
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
    state.risks.push({ ...risk, originRun: runId, status: 'open', history: [] })
  }
  for (const d of report.decisions) state.decisions.push(d.id)

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

  // -- write: ledger append, prose appends, then state last (atomic rename) --
  const p = paths(root)
  const date = new Date().toISOString()
  const lines: LedgerLine[] = [{
    type: 'run', id: runId, date, mode: report.run.mode, spec: report.run.spec,
    commitRange: report.run.commitRange, gate: report.run.gate,
    slices: report.slices.map((s) => ({ id: s.id, class: s.class, verdict: s.verdict })),
  }]
  let bounces = 0
  for (const s of report.slices) {
    for (const b of s.bounces) {
      bounces++
      lines.push({ type: 'bounce', run: runId, slice: s.id, class: s.class, ac: b.ac, reason: b.reason })
    }
  }
  appendFileSync(p.ledger, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  for (const d of report.decisions) {
    const supersedes = d.supersedes !== undefined ? `\nSupersedes: ${d.supersedes}` : ''
    appendFileSync(p.decisions, `\n## ${d.id}: ${d.title}\n\nStatus: active (run: ${runId}, ${date})${supersedes}\n\n${d.body}\n`)
  }
  for (const c of report.conventions) {
    appendFileSync(p.conventions, `\n- ${c.id} (run: ${runId}): ${c.rule}\n`)
  }

  saveState(root, state)
  return { run: runId, risksClosed, risksDeferred, risksNew: report.risks.new.map((r) => r.id), bounces, demoted, stampsAdvanced }
}

// ---------- recall ----------

export type RecallPacket = {
  grounding: Staleness
  partition: { commit: string | null, stale: boolean, reason: Staleness['reason'], staleSlices: { id: string, changed: string[] }[] }
  mustTriage: Risk[]
  pendingTriage: State['pendingTriage']
  decisions: { file: string, count: number }
  conventions: { file: string }
  topBounces: { class: string, reason: string, count: number }[]
  ratchet: RatchetClass[]
  lastRun: { id: string, date: string, mode: Mode, gate: Gate, commitRange: string } | null
  runCount: number
}

export function cmdRecall(root: string): RecallPacket {
  const state = loadState(root)
  const ledger = readLedger(root)

  const partitionBase = staleness(root, state.partition.commit, [])
  const staleSlices: { id: string, changed: string[] }[] = []
  if (state.partition.commit !== null && partitionBase.reason !== 'missing-commit') {
    const changed = changedSince(root, state.partition.commit)
    for (const slice of state.partition.slices) {
      const hits = changed.filter((f) => slice.paths.some((w) => f.startsWith(w)))
      if (hits.length > 0) staleSlices.push({ id: slice.id, changed: hits })
    }
  }
  const partitionStale = partitionBase.reason === 'no-stamp' || partitionBase.reason === 'missing-commit' || staleSlices.length > 0

  const bounceCounts = new Map<string, number>()
  for (const line of ledger) {
    if (line.type !== 'bounce') continue
    const key = `${line.class} ${line.reason}`
    bounceCounts.set(key, (bounceCounts.get(key) ?? 0) + 1)
  }
  const topBounces = [...bounceCounts.entries()]
    .map(([key, count]) => {
      const [cls = '', reason = ''] = key.split(' ')
      return { class: cls, reason, count }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  const runs = ledger.filter((l): l is RunLine => l.type === 'run')
  const last = runs[runs.length - 1]

  return {
    grounding: staleness(root, state.grounding.commit, state.grounding.watch),
    partition: {
      commit: state.partition.commit,
      stale: partitionStale,
      reason: partitionStale ? (staleSlices.length > 0 ? 'watch-touched' : partitionBase.reason) : null,
      staleSlices,
    },
    mustTriage: state.risks.filter((r) => r.status === 'open'),
    pendingTriage: state.pendingTriage,
    decisions: { file: '.galaxy/DECISIONS.md', count: state.decisions.length },
    conventions: { file: '.galaxy/CONVENTIONS.md' },
    topBounces,
    ratchet: computeRatchet(state, ledger),
    lastRun: last !== undefined ? { id: last.id, date: last.date, mode: last.mode, gate: last.gate, commitRange: last.commitRange } : null,
    runCount: runs.length,
  }
}

// ---------- CLI ----------

const USAGE = `usage: galaxy <command> [args] [--root <dir>]

commands:
  init                                    create .galaxy/ factory state
  recall                                  emit the rehydration packet (JSON)
  triage [<risk-id> <action> --reason <text>]
                                          record a disposition (finding|defer|close); bare lists open risks
  persist <run-report.json>               close the loop: validate, gate on triage, append ledger, advance stamps
  ratchet [<class>] [--grant <level> --approved-by <name>]
                                          advisory autonomy verdicts; grant only with named human approval`

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}

function main(argv: string[]): number {
  const args = [...argv]
  const root = flag(args, '--root') ?? process.cwd()
  const reason = flag(args, '--reason')
  const grant = flag(args, '--grant')
  const approvedBy = flag(args, '--approved-by')
  const [command, ...rest] = args

  try {
    switch (command) {
      case 'init':
        print(cmdInit(root))
        return 0
      case 'recall':
        print(cmdRecall(root))
        return 0
      case 'triage': {
        const [riskId, action] = rest
        if (riskId === undefined) {
          print({ openRisks: loadState(root).risks.filter((r) => r.status === 'open'), pendingTriage: loadState(root).pendingTriage })
          return 0
        }
        if (action !== 'finding' && action !== 'defer' && action !== 'close') throw new GalaxyError('triage action must be finding, defer, or close')
        print(cmdTriage(root, riskId, action, reason ?? ''))
        return 0
      }
      case 'persist': {
        const [reportPath] = rest
        if (reportPath === undefined) throw new GalaxyError('persist requires a run-report.json path')
        print(cmdPersist(root, reportPath))
        return 0
      }
      case 'ratchet': {
        const [cls] = rest
        const opts = grant !== undefined ? { grant: Number(grant), approvedBy: approvedBy ?? '' } : undefined
        print(cmdRatchet(root, cls, opts))
        return 0
      }
      default:
        process.stderr.write(`${USAGE}\n`)
        return 1
    }
  } catch (e) {
    process.stderr.write(`galaxy: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)))
}
