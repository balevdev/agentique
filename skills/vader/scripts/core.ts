// vader core: the shared foundation. The error type, the hand-rolled validation primitives,
// the on-disk layout, and the factory state record with its load/save/validate. This is the
// data backbone every other module reads and writes; it imports nothing from the rest of vader,
// so the dependency graph stays acyclic with this as the single leaf.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export class VaderError extends Error {}

// ---------- validation primitives (hand-rolled, named paths in every error) ----------
// Used wherever a parsed-but-untrusted value enters: the run report (memory), the gate config
// (gate), and the state/ledger files (here). We never trust a JSON.parse with an unchecked cast.

export function fail(path: string, msg: string): never {
  throw new VaderError(`invalid ${path}: ${msg}`)
}

export function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object')
  return value as Record<string, unknown>
}

export function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') fail(path, 'must be a non-empty string')
  return value
}

export function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  return value
}

export function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function strOpt(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  return value
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number')
  return value
}

function nullableStr(value: unknown, path: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') fail(path, 'must be a string or null')
  return value
}

// ---------- factory state (merged: vader roadmap/model + galaxy memory) ----------

export type RoadmapStatus = 'pending' | 'in-progress' | 'done' | 'blocked'
export type RoadmapItem = { id: string; title: string; slicePaths: string[]; status: RoadmapStatus }

export type Mode = 'build' | 'review'
export type Gate = 'green' | 'residual' | 'failed'
export type Severity = 'low' | 'medium' | 'high'
export type TriageAction = 'finding' | 'defer' | 'close'

export type PartitionSlice = { id: string; class: string; paths: string[] }
export type Grant = { level: number; approvedBy: string; date: string; note?: string }

export type Risk = {
  id: string
  desc: string
  owner: string
  severity: Severity
  originRun: string
  status: 'open' | 'closed'
  history: { run: string; action: TriageAction; reason: string }[]
}

export type ModelChange = { proposedBy: string; reason: string; diff: string }

export type State = {
  version: 1
  modelHash: string | null
  // Locks the compiled enforcement surface (generated/checks + gate.json), not just the model
  // text. The model hash proves the model is unchanged; this proves the checks the model
  // compiled to, and the repo-check command the gate runs, are unchanged too. null until the
  // first `gen` engages it, the same way modelHash is null before the model is frozen.
  enforcementHash: string | null
  roadmap: RoadmapItem[]
  pendingModelChange: ModelChange | null
  grounding: { commit: string | null; watch: string[] }
  partition: { commit: string | null; slices: PartitionSlice[] }
  risks: Risk[]
  pendingTriage: { riskId: string; action: TriageAction; reason: string }[]
  decisions: string[]
  ratchet: { grants: Record<string, Grant>; neverRatchet: string[] }
}

export type RunLine = {
  type: 'run'
  id: string
  date: string
  mode: Mode
  spec: string
  commitRange: string
  gate: Gate
  slices: { id: string; class: string; verdict: 'accept' | 'bounce' }[]
}
export type BounceLine = { type: 'bounce'; run: string; slice: string; class: string; ac: string; reason: string }
export type LedgerLine = RunLine | BounceLine

export type Staleness = {
  commit: string | null
  stale: boolean
  reason: 'no-stamp' | 'missing-commit' | 'watch-touched' | null
  changed: string[]
}

const NEVER_RATCHET_DEFAULT = ['seam', 'security', 'migration']

// ---------- filesystem layout ----------

export function paths(root: string) {
  const dir = join(root, '.vader')
  return {
    dir,
    state: join(dir, 'state.json'),
    ledger: join(dir, 'LEDGER.jsonl'),
    modelTs: join(dir, 'constitution.model.ts'),
    modelJson: join(dir, 'constitution.model.json'),
    generated: join(dir, 'generated'),
    gate: join(dir, 'gate.json'),
    spec: join(dir, 'spec'),
    runs: join(dir, 'runs'),
    grounding: join(dir, 'GROUNDING.md'),
    decisions: join(dir, 'DECISIONS.md'),
    conventions: join(dir, 'CONVENTIONS.md'),
  }
}

export function defaultState(): State {
  return {
    version: 1,
    modelHash: null,
    enforcementHash: null,
    roadmap: [],
    pendingModelChange: null,
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
  if (!existsSync(p.state)) throw new VaderError(`no factory state at ${p.state}; run "vader init" first`)
  return validateState(JSON.parse(readFileSync(p.state, 'utf8')))
}

export function saveState(root: string, state: State): void {
  const p = paths(root)
  const tmp = `${p.state}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  renameSync(tmp, p.state)
}

export function readLedger(root: string): LedgerLine[] {
  const raw = readFileSync(paths(root).ledger, 'utf8').trim()
  if (raw === '') return []
  return raw.split('\n').map((l, i) => validateLedgerLine(JSON.parse(l), `LEDGER.jsonl:${i + 1}`))
}

// ---------- machine-state validation (the .vader files vader itself writes, but which a
// human can hand-edit; we never trust a parse with an unchecked cast) ----------

function sliceOf(value: unknown, path: string): PartitionSlice {
  const s = obj(value, path)
  return {
    id: str(s.id, `${path}.id`),
    class: str(s.class, `${path}.class`),
    paths: arr(s.paths, `${path}.paths`).map((p, j) => str(p, `${path}.paths[${j}]`)),
  }
}

function riskOf(value: unknown, path: string): Risk {
  const r = obj(value, path)
  return {
    id: str(r.id, `${path}.id`),
    desc: str(r.desc, `${path}.desc`),
    owner: str(r.owner, `${path}.owner`),
    severity: oneOf(r.severity, `${path}.severity`, ['low', 'medium', 'high'] as const),
    originRun: strOpt(r.originRun, `${path}.originRun`),
    status: oneOf(r.status, `${path}.status`, ['open', 'closed'] as const),
    history: arr(r.history, `${path}.history`).map((h, j) => {
      const hi = obj(h, `${path}.history[${j}]`)
      return {
        run: str(hi.run, `${path}.history[${j}].run`),
        action: oneOf(hi.action, `${path}.history[${j}].action`, ['finding', 'defer', 'close'] as const),
        reason: strOpt(hi.reason, `${path}.history[${j}].reason`),
      }
    }),
  }
}

export function modelChangeOf(value: unknown, path: string): ModelChange {
  const m = obj(value, path)
  return {
    proposedBy: str(m.proposedBy, `${path}.proposedBy`),
    reason: str(m.reason, `${path}.reason`),
    diff: str(m.diff, `${path}.diff`),
  }
}

function validateState(input: unknown): State {
  const s = obj(input, 'state')
  if (s.version !== 1) fail('state.version', 'must be 1')
  const grounding = obj(s.grounding, 'state.grounding')
  const partition = obj(s.partition, 'state.partition')
  const ratchet = obj(s.ratchet, 'state.ratchet')
  const grants = obj(ratchet.grants, 'state.ratchet.grants')
  const outGrants: Record<string, Grant> = {}
  for (const [k, v] of Object.entries(grants)) {
    const g = obj(v, `state.ratchet.grants.${k}`)
    const grant: Grant = {
      level: num(g.level, `state.ratchet.grants.${k}.level`),
      approvedBy: strOpt(g.approvedBy, `state.ratchet.grants.${k}.approvedBy`),
      date: strOpt(g.date, `state.ratchet.grants.${k}.date`),
    }
    if (g.note !== undefined) grant.note = strOpt(g.note, `state.ratchet.grants.${k}.note`)
    outGrants[k] = grant
  }
  return {
    version: 1,
    modelHash: nullableStr(s.modelHash, 'state.modelHash'),
    // a state.json written before this field existed has no enforcementHash: treat as not-yet-locked.
    enforcementHash: s.enforcementHash === undefined ? null : nullableStr(s.enforcementHash, 'state.enforcementHash'),
    roadmap: arr(s.roadmap, 'state.roadmap').map((x, i) => {
      const r = obj(x, `state.roadmap[${i}]`)
      return {
        id: str(r.id, `state.roadmap[${i}].id`),
        title: str(r.title, `state.roadmap[${i}].title`),
        slicePaths: arr(r.slicePaths, `state.roadmap[${i}].slicePaths`).map((p, j) =>
          str(p, `state.roadmap[${i}].slicePaths[${j}]`),
        ),
        status: oneOf(r.status, `state.roadmap[${i}].status`, ['pending', 'in-progress', 'done', 'blocked'] as const),
      }
    }),
    pendingModelChange:
      s.pendingModelChange === null ? null : modelChangeOf(s.pendingModelChange, 'state.pendingModelChange'),
    grounding: {
      commit: nullableStr(grounding.commit, 'state.grounding.commit'),
      watch: arr(grounding.watch, 'state.grounding.watch').map((w, i) => str(w, `state.grounding.watch[${i}]`)),
    },
    partition: {
      commit: nullableStr(partition.commit, 'state.partition.commit'),
      slices: arr(partition.slices, 'state.partition.slices').map((x, i) =>
        sliceOf(x, `state.partition.slices[${i}]`),
      ),
    },
    risks: arr(s.risks, 'state.risks').map((x, i) => riskOf(x, `state.risks[${i}]`)),
    pendingTriage: arr(s.pendingTriage, 'state.pendingTriage').map((x, i) => {
      const t = obj(x, `state.pendingTriage[${i}]`)
      return {
        riskId: str(t.riskId, `state.pendingTriage[${i}].riskId`),
        action: oneOf(t.action, `state.pendingTriage[${i}].action`, ['finding', 'defer', 'close'] as const),
        reason: strOpt(t.reason, `state.pendingTriage[${i}].reason`),
      }
    }),
    decisions: arr(s.decisions, 'state.decisions').map((d, i) => str(d, `state.decisions[${i}]`)),
    ratchet: {
      grants: outGrants,
      neverRatchet: arr(ratchet.neverRatchet, 'state.ratchet.neverRatchet').map((c, i) =>
        str(c, `state.ratchet.neverRatchet[${i}]`),
      ),
    },
  }
}

function validateLedgerLine(input: unknown, path: string): LedgerLine {
  const l = obj(input, path)
  const type = oneOf(l.type, `${path}.type`, ['run', 'bounce'] as const)
  if (type === 'bounce') {
    return {
      type: 'bounce',
      run: str(l.run, `${path}.run`),
      slice: str(l.slice, `${path}.slice`),
      class: str(l.class, `${path}.class`),
      ac: str(l.ac, `${path}.ac`),
      reason: strOpt(l.reason, `${path}.reason`),
    }
  }
  return {
    type: 'run',
    id: str(l.id, `${path}.id`),
    date: str(l.date, `${path}.date`),
    mode: oneOf(l.mode, `${path}.mode`, ['build', 'review'] as const),
    spec: strOpt(l.spec, `${path}.spec`),
    commitRange: strOpt(l.commitRange, `${path}.commitRange`),
    gate: oneOf(l.gate, `${path}.gate`, ['green', 'residual', 'failed'] as const),
    slices: arr(l.slices, `${path}.slices`).map((s, i) => {
      const slice = obj(s, `${path}.slices[${i}]`)
      return {
        id: str(slice.id, `${path}.slices[${i}].id`),
        class: str(slice.class, `${path}.slices[${i}].class`),
        verdict: oneOf(slice.verdict, `${path}.slices[${i}].verdict`, ['accept', 'bounce'] as const),
      }
    }),
  }
}
