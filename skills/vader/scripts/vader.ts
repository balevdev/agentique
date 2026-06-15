#!/usr/bin/env bun
// vader: the deterministic spine of an app-agnostic software factory.
// One module. The CLI owns .vader/ machine state (state.json, LEDGER.jsonl); the driving
// agent owns the prose files and runs/<id>/. Agents read factory state, never write it.
//
// Two things live here, by design fused into one spine:
//   1. The constitution: a human-gated, hash-locked model. `vader gen` compiles each
//      invariant into a deterministic check; `vader gate` runs them and reports pass/fail
//      by invariant id. A failed id is an automatic verifier bounce. A tick may PROPOSE a
//      model change, never apply one (the anti-decay lock).
//   2. The memory: verify-before-trust recall, triage-gated persist, an evidence-derived
//      ratchet, and a bounce-pattern ledger, so the factory learns instead of decaying.
//
// Commands: init, gen, gate, recall, triage, persist, ratchet.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync, execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { createHash } from 'node:crypto'

export class VaderError extends Error {}

// ---------- constitution model ----------

export type InvariantKind = 'shape' | 'dependency' | 'behavioral' | 'data'

export type ShapeCheck = { distinct: [string, string]; relation?: string }
export type DependencyCheck = { forbidImport: { from: string; to: string } }
export type BehavioralCheck = { contractTest: string }
export type DataCheck = { law: string; sample: { kind: 'int' | 'string'; count: number } }
export type EscapeCheck = { rawCheck: string }

export type InvariantCheck =
  | ShapeCheck
  | DependencyCheck
  | BehavioralCheck
  | DataCheck
  | EscapeCheck

export type Invariant = {
  id: string
  kind: InvariantKind
  statement: string
  check: InvariantCheck
}

export type Concept = { kind: InvariantKind; note: string }

export type Constitution = {
  concepts: Record<string, Concept>
  invariants: Invariant[]
}

const KINDS: InvariantKind[] = ['shape', 'dependency', 'behavioral', 'data']

export function validateConstitution(raw: unknown): Constitution {
  if (typeof raw !== 'object' || raw === null) throw new VaderError('constitution must be an object')
  const c = raw as Record<string, unknown>
  const invariants = c.invariants
  if (!Array.isArray(invariants)) throw new VaderError('constitution.invariants must be an array')
  const ids = new Set<string>()
  // An id becomes part of generated filenames and import paths (shape-<id>.types.ts), and
  // a distinct name becomes a generated TS type identifier. Reject anything outside a safe
  // charset here, so a bad model fails at readModel with a clear message instead of emitting
  // broken code that only fails later at tsc (or, worse, escapes the generated directory).
  const ID_SAFE = /^[A-Za-z0-9._-]+$/
  const IDENT_SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/
  for (const inv of invariants) {
    const i = inv as Record<string, unknown>
    if (typeof i.id !== 'string' || i.id === '') throw new VaderError('invariant id required')
    if (!ID_SAFE.test(i.id))
      throw new VaderError(`invariant ${i.id}: id must match ${ID_SAFE.source}`)
    if (ids.has(i.id)) throw new VaderError(`duplicate invariant id ${i.id}`)
    ids.add(i.id)
    const isEscape =
      typeof i.check === 'object' && i.check !== null && 'rawCheck' in (i.check as object)
    if (!isEscape && !KINDS.includes(i.kind as InvariantKind))
      throw new VaderError(
        `invariant ${i.id}: kind must be one of ${KINDS.join(', ')} (or use an escape rawCheck)`,
      )
    const check = i.check
    if (typeof check === 'object' && check !== null && 'distinct' in check) {
      const distinct = (check as { distinct: unknown }).distinct
      if (!Array.isArray(distinct) || distinct.length !== 2)
        throw new VaderError(`invariant ${i.id}: shape distinct must be a pair of names`)
      for (const name of distinct) {
        if (typeof name !== 'string' || !IDENT_SAFE.test(name))
          throw new VaderError(`invariant ${i.id}: distinct name ${String(name)} must be a TS identifier`)
      }
    }
  }
  return raw as Constitution
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

type RunLine = {
  type: 'run'
  id: string
  date: string
  mode: Mode
  spec: string
  commitRange: string
  gate: Gate
  slices: { id: string; class: string; verdict: 'accept' | 'bounce' }[]
}
type BounceLine = { type: 'bounce'; run: string; slice: string; class: string; ac: string; reason: string }
type LedgerLine = RunLine | BounceLine

export type Staleness = {
  commit: string | null
  stale: boolean
  reason: 'no-stamp' | 'missing-commit' | 'watch-touched' | null
  changed: string[]
}

export type RatchetClass = {
  class: string
  level: number
  eligible: number
  consecutiveClean: number
  neverRatchet: boolean
}

const NEVER_RATCHET_DEFAULT = ['seam', 'security', 'migration']
const LEVELS = { L1_CLEAN_RUNS: 2, L2_CLEAN_RUNS: 3 }

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

function defaultState(): State {
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

function saveState(root: string, state: State): void {
  const p = paths(root)
  const tmp = `${p.state}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  renameSync(tmp, p.state)
}

function readLedger(root: string): LedgerLine[] {
  const raw = readFileSync(paths(root).ledger, 'utf8').trim()
  if (raw === '') return []
  return raw.split('\n').map((l, i) => validateLedgerLine(JSON.parse(l), `LEDGER.jsonl:${i + 1}`))
}

export function hashModel(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

// Reads the model: prefers the JSON form (machine truth); falls back to importing the TS
// form under bun. Returns the parsed constitution AND the raw text the hash is taken over.
export async function readModel(root: string): Promise<{ model: Constitution; raw: string }> {
  const p = paths(root)
  if (existsSync(p.modelJson)) {
    const raw = readFileSync(p.modelJson, 'utf8')
    return { model: validateConstitution(JSON.parse(raw)), raw }
  }
  if (existsSync(p.modelTs)) {
    const raw = readFileSync(p.modelTs, 'utf8')
    const mod = (await import(p.modelTs)) as { constitution?: unknown }
    if (mod.constitution === undefined)
      throw new VaderError('constitution.model.ts must export `constitution`')
    return { model: validateConstitution(mod.constitution), raw }
  }
  throw new VaderError(`no constitution model at ${p.modelJson} or ${p.modelTs}`)
}

// Hashes the compiled enforcement surface: every file under generated/checks (sorted by path,
// content included) plus gate.json. `gen` locks this; `gate` recomputes it from disk and fails
// closed on any drift. This is what makes "an agent cannot edit generated/ or gate.json to
// silence a check" a mechanical guarantee rather than a prose promise. Deterministic across
// hosts: the file list is sorted and the relative path travels in the hashed text.
function listFilesSorted(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listFilesSorted(full))
    else out.push(full)
  }
  return out.sort()
}

export function enforcementHash(root: string): string {
  const p = paths(root)
  const parts: string[] = []
  for (const f of listFilesSorted(join(p.generated, 'checks'))) {
    parts.push(relative(root, f) + '\0' + readFileSync(f, 'utf8'))
  }
  parts.push('gate.json\0' + (existsSync(p.gate) ? readFileSync(p.gate, 'utf8') : ''))
  return hashModel(parts.join('\0\0'))
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

// A changed file counts against a watch entry only on a path boundary: 'src/a' must not
// match 'src/ab.ts'. An exact file path matches itself; a directory prefix matches its tree.
function underWatch(file: string, watch: string[]): boolean {
  return watch.some((w) => file === w || file.startsWith(w.endsWith('/') ? w : `${w}/`))
}

function staleness(root: string, commit: string | null, watch: string[]): Staleness {
  if (commit === null) return { commit, stale: true, reason: 'no-stamp', changed: [] }
  if (!commitExists(root, commit)) return { commit, stale: true, reason: 'missing-commit', changed: [] }
  const changed = changedSince(root, commit).filter((f) => underWatch(f, watch))
  return changed.length > 0
    ? { commit, stale: true, reason: 'watch-touched', changed }
    : { commit, stale: false, reason: null, changed: [] }
}

// ---------- toolchain + fallow detection ----------

export type GateConfig = { repoCheck: string[]; fallowCheck?: string[]; note?: string }

// A binary resolves if invoking it does not fail with ENOENT. A nonzero exit (e.g. an
// unknown flag) still means the binary is on PATH.
function binaryResolves(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' })
    return true
  } catch (e) {
    return (e as { code?: string }).code !== 'ENOENT'
  }
}

function detectFallow(root: string): string[] | undefined {
  const configured =
    existsSync(join(root, '.fallowrc.jsonc')) ||
    existsSync(join(root, '.fallowrc.json')) ||
    existsSync(join(root, '.fallowrc'))
  if (!configured || !binaryResolves('fallow')) return undefined
  return ['fallow', 'audit', '--gate', 'new-only']
}

export function detectGate(root: string): GateConfig {
  const fallowCheck = detectFallow(root)
  const withFallow = (g: GateConfig): GateConfig => (fallowCheck ? { ...g, fallowCheck } : g)
  if (existsSync(join(root, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    if (pkg.scripts?.check) return withFallow({ repoCheck: ['bun', 'run', 'check'] })
    if (existsSync(join(root, 'tsconfig.json'))) return withFallow({ repoCheck: ['bunx', 'tsc', '--noEmit'] })
    return withFallow({ repoCheck: ['bun', 'test'] })
  }
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'setup.py')))
    return withFallow({ repoCheck: ['pytest', '-q'] })
  if (existsSync(join(root, 'Cargo.toml'))) return withFallow({ repoCheck: ['cargo', 'check'] })
  if (existsSync(join(root, 'go.mod'))) return withFallow({ repoCheck: ['go', 'build', './...'] })
  return withFallow({
    repoCheck: ['echo', 'TODO: set repoCheck in .vader/gate.json'],
    note: 'no toolchain detected; fill in the real check command',
  })
}

// ---------- init ----------

const GROUNDING_STUB = `# Grounding (stable layer)

Written by the session, stamped via state.json. Refresh only when recall flags it stale.
Sections: glossary, module graph, integration seams, cross-cutting conventions, the mantra.
`

export function cmdInit(root: string): { created: string[]; gate: GateConfig } {
  const p = paths(root)
  const created: string[] = []
  for (const d of [p.dir, p.generated, p.spec, p.runs]) {
    if (!existsSync(d)) {
      mkdirSync(d, { recursive: true })
      created.push(relative(root, d))
    }
  }
  if (!existsSync(p.state)) {
    saveState(root, defaultState())
    created.push('.vader/state.json')
  }
  if (!existsSync(p.ledger)) {
    writeFileSync(p.ledger, '')
    created.push('.vader/LEDGER.jsonl')
  }
  for (const [file, body] of [
    [p.grounding, GROUNDING_STUB],
    [p.decisions, '# Decisions\n\nAppend-only ADR log, written by vader persist.\n'],
    [p.conventions, '# Conventions\n\nFrozen conventions with origin run, written by vader persist.\n'],
  ] as const) {
    if (!existsSync(file)) {
      writeFileSync(file, body)
      created.push(relative(root, file))
    }
  }
  const gate = detectGate(root)
  if (!existsSync(p.gate)) {
    writeFileSync(p.gate, JSON.stringify(gate, null, 2) + '\n')
    created.push('.vader/gate.json')
  }
  if (!existsSync(p.modelJson) && !existsSync(p.modelTs)) {
    const stub: Constitution = { concepts: {}, invariants: [] }
    writeFileSync(p.modelJson, JSON.stringify(stub, null, 2) + '\n')
    created.push('.vader/constitution.model.json')
  }
  for (const f of ['IDEA.md', 'SPEC.md', 'ROADMAP.md']) {
    const fp = join(p.spec, f)
    if (!existsSync(fp)) {
      writeFileSync(fp, `# ${f.replace('.md', '')}\n`)
      created.push(relative(root, fp))
    }
  }
  return { created, gate }
}

// ---------- router: model -> generated checks ----------

export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
      } else {
        out += '[^/]*'
      }
    } else if (ch !== undefined && '.+^${}()|[]\\'.includes(ch)) {
      out += '\\' + ch
    } else {
      out += ch
    }
  }
  return new RegExp('^' + out + '$')
}

// A generated dependency check: a standalone bun script that scans `from` files for imports
// matching `to` and exits nonzero on any violation.
function genDependency(inv: Invariant, check: DependencyCheck): { file: string; body: string } {
  const { from, to } = check.forbidImport
  const fromRe = globToRegExp(from)
  const toRe = globToRegExp(to)
  const body = `#!/usr/bin/env bun
// GENERATED by vader from invariant ${inv.id}. Do not edit.
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2] ?? process.cwd()
const fromRe = ${fromRe}
const toRe = ${toRe}
const files = []
function walk(d) {
  for (const e of readdirSync(d)) {
    if (e === 'node_modules' || e === '.git' || e === '.vader') continue
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else files.push(p)
  }
}
walk(root)
const rel = (p) => p.slice(root.length + 1)
const viol = []
for (const f of files) {
  if (!fromRe.test(rel(f))) continue
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(/(?:from|import|require)\\s*\\(?\\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1]
    if (toRe.test(spec) || toRe.test(rel(join(f, '..', spec)))) viol.push(rel(f) + ' -> ' + spec)
  }
}
if (viol.length) {
  console.error('${inv.id} violated:\\n' + viol.join('\\n'))
  process.exit(1)
}
console.log('${inv.id} ok')
`
  return { file: `checks/dep-${inv.id}.ts`, body }
}

// A generated data-law check: seeded-input property test, zero-dep. The repo provides
// .vader/laws/law-<id>.ts exporting law(input): boolean.
function genData(inv: Invariant, check: DataCheck): { file: string; body: string } {
  const lawImport = `../../laws/law-${inv.id}.ts`
  const body = `import { test, expect } from 'bun:test'
// GENERATED by vader from invariant ${inv.id}. Do not edit.
// LAW: ${check.law}
import { law } from '${lawImport}'
function* seeded(seed, count, kind) {
  let s = seed
  for (let i = 0; i < count; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    yield kind === 'int' ? s % 100000 : 'k' + (s % 1000)
  }
}
test('${inv.id}: ${check.law.replace(/'/g, "\\'")}', () => {
  for (const input of seeded(1, ${check.sample.count}, '${check.sample.kind}')) {
    expect(law(input)).toBe(true)
  }
})
`
  return { file: `checks/data-${inv.id}.test.ts`, body }
}

// A generated shape check (TS gold path): branded nominal types + a type-level test whose
// expect-error lines FAIL to compile if the distinction is lost.
function genShape(inv: Invariant, check: ShapeCheck): { file: string; body: string }[] {
  const [A, B] = check.distinct
  const types = `// GENERATED by vader from invariant ${inv.id}. Do not edit.
declare const __brand: unique symbol
export type ${A} = number & { readonly [__brand]: '${A}' }
export type ${B} = { readonly t0: number; readonly t1: number } & { readonly [__brand]: '${B}' }
export const as${A} = (n: number): ${A} => n as ${A}
export const as${B} = (t0: number, t1: number): ${B} => ({ t0, t1 }) as unknown as ${B}
// ${check.relation ?? `relation: pointInInterval(p: ${A}, iv: ${B})`}
export const pointInInterval = (p: ${A}, iv: ${B}): boolean => p >= iv.t0 && p <= iv.t1
`
  const neg = `// GENERATED by vader from invariant ${inv.id}. Do not edit.
// This file MUST typecheck. Each @ts-expect-error proves the distinction holds:
// if a line stops erroring, ${A} and ${B} have been collapsed and tsc fails here.
import { pointInInterval, as${A}, as${B} } from './shape-${inv.id}.types'
const p = as${A}(5)
const iv = as${B}(0, 10)
void pointInInterval(p, iv)
// @ts-expect-error a ${B} is not a ${A}
void pointInInterval(iv, iv)
// @ts-expect-error a ${A} is not a ${B}
void pointInInterval(p, p)
`
  return [
    { file: `checks/shape-${inv.id}.types.ts`, body: types },
    { file: `checks/shape-${inv.id}.neg.ts`, body: neg },
  ]
}

// A generated behavioral contract stub: red until the owner provides the harness.
function genBehavioral(inv: Invariant, check: BehavioralCheck): { file: string; body: string } {
  const harnessImport = `../../contracts/${check.contractTest}.ts`
  const body = `import { test, expect } from 'bun:test'
// GENERATED by vader from invariant ${inv.id}. Do not edit.
// CONTRACT: ${inv.statement}
// The owner must provide .vader/contracts/${check.contractTest}.ts exporting
//   run(): { outcomePreserved: boolean }
import { run } from '${harnessImport}'
test('${inv.id}: ${inv.statement.replace(/'/g, "\\'")}', () => {
  expect(run().outcomePreserved).toBe(true)
})
`
  return { file: `checks/behavioral-${inv.id}.test.ts`, body }
}

export async function cmdGen(root: string): Promise<{ written: string[]; modelHash: string }> {
  const p = paths(root)
  const { model, raw } = await readModel(root)
  const checksDir = join(p.generated, 'checks')
  if (existsSync(checksDir)) rmSync(checksDir, { recursive: true })
  mkdirSync(checksDir, { recursive: true })
  const written: string[] = []
  for (const inv of model.invariants) {
    const outs: { file: string; body: string }[] = []
    if ('forbidImport' in inv.check) outs.push(genDependency(inv, inv.check))
    else if ('law' in inv.check) outs.push(genData(inv, inv.check))
    else if ('distinct' in inv.check) outs.push(...genShape(inv, inv.check))
    else if ('contractTest' in inv.check) outs.push(genBehavioral(inv, inv.check))
    // escape (rawCheck) invariants generate no artifact; the gate runs them directly.
    for (const o of outs) {
      const fp = join(p.generated, o.file)
      writeFileSync(fp, o.body)
      written.push(relative(root, fp))
    }
  }
  // Lock the hash of the model just compiled: from now on the gate fails closed if the
  // on-disk model is edited without a re-gen. This is where the anti-decay lock engages
  // (after the P0 human freeze, and again after an approved model change re-compiles).
  const state = loadState(root)
  const modelHash = hashModel(raw)
  state.modelHash = modelHash
  // Lock the compiled surface too (generated checks + the gate.json read at gate time), now that
  // the files are written. From here a hand-edit of either fails the gate closed.
  state.enforcementHash = enforcementHash(root)
  saveState(root, state)
  return { written, modelHash }
}

// ---------- gate ----------

export type GateResult = {
  pass: boolean
  modelHashLocked: boolean
  enforcementLocked: boolean
  repoCheck: { cmd: string; pass: boolean } | null
  fallow: { cmd: string; pass: boolean } | null
  invariants: { id: string; pass: boolean; detail: string }[]
}

// One check process. Async so the gate can run independent checks concurrently; the verdict
// is exactly the child's exit code, so parallelism cannot change a pass/fail. Returns the FULL
// output (callers slice for storage) because shape-batch attribution needs the whole tsc log.
function runCheck(root: string, cmd: string[]): Promise<{ pass: boolean; out: string }> {
  const head = cmd[0]
  if (head === undefined) return Promise.resolve({ pass: false, out: 'empty command' })
  return new Promise((resolve) => {
    // 64 MiB: a passing tsc/bun-test in a large repo can print well past the 1 MiB default,
    // and an overflow would otherwise surface as a false gate failure.
    execFile(head, cmd.slice(1), { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      // Combine both streams: tsc writes diagnostics to stdout while a runner like bunx writes
      // progress to stderr, and shape-batch attribution needs the diagnostic lines regardless of
      // which stream carried them.
      if (err) resolve({ pass: false, out: `${stdout || ''}\n${stderr || ''}`.trim() || err.message || 'failed' })
      else resolve({ pass: true, out: stdout || '' })
    })
  })
}

const DETAIL_CAP = 400

// Run items through fn with at most `limit` in flight, preserving input order in the result.
// Order independence of the verdicts is the whole point: a slot scheduler cannot reorder a
// pass into a fail, and re-indexing by position keeps the per-invariant report deterministic.
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
  return results
}

// The non-shape invariants each map to one process. Shape is handled by runShapeBatch, so it is
// intentionally absent here; an unrecognized check shape fails closed.
function invariantCmd(p: ReturnType<typeof paths>, root: string, inv: Invariant): string[] | null {
  if ('rawCheck' in inv.check) return ['bash', '-c', inv.check.rawCheck]
  if ('forbidImport' in inv.check) return ['bun', join(p.generated, 'checks', `dep-${inv.id}.ts`), root]
  if ('law' in inv.check) return ['bun', 'test', join(p.generated, 'checks', `data-${inv.id}.test.ts`)]
  if ('contractTest' in inv.check) return ['bun', 'test', join(p.generated, 'checks', `behavioral-${inv.id}.test.ts`)]
  return null
}

// All shape neg files typecheck in ONE tsc invocation (a cold tsc start, ~0.9s, dominated the
// serial gate; batching pays it once). tsc reports every error with its file path, so a failure
// is attributed to the owning invariant by filename. Fail-closed safety: if tsc exits nonzero
// but no error names a shape file (a global config error), every shape id fails rather than
// silently passing.
async function runShapeBatch(
  p: ReturnType<typeof paths>,
  root: string,
  shapes: Invariant[],
): Promise<Map<string, { pass: boolean; detail: string }>> {
  const out = new Map<string, { pass: boolean; detail: string }>()
  if (shapes.length === 0) return out
  const files = shapes.map((s) => join(p.generated, 'checks', `shape-${s.id}.neg.ts`))
  const res = await runCheck(root, ['bunx', 'tsc', '--noEmit', '--strict', '--skipLibCheck', ...files])
  if (res.pass) {
    for (const s of shapes) out.set(s.id, { pass: true, detail: 'ok' })
    return out
  }
  const lines = res.out.split('\n')
  const hits = new Map<string, string[]>()
  let anyAttributed = false
  for (const s of shapes) {
    const matched = lines.filter((l) => l.includes(`shape-${s.id}.neg.ts`) || l.includes(`shape-${s.id}.types`))
    if (matched.length > 0) anyAttributed = true
    hits.set(s.id, matched)
  }
  for (const s of shapes) {
    const matched = hits.get(s.id) ?? []
    if (matched.length > 0) out.set(s.id, { pass: false, detail: matched.join('\n').slice(0, DETAIL_CAP) })
    else if (!anyAttributed) out.set(s.id, { pass: false, detail: res.out.slice(0, DETAIL_CAP) })
    else out.set(s.id, { pass: true, detail: 'ok' })
  }
  return out
}

export async function cmdGate(root: string): Promise<GateResult> {
  const p = paths(root)
  const state = loadState(root)
  const { model, raw } = await readModel(root)
  const modelHashLocked = state.modelHash === null || state.modelHash === hashModel(raw)
  // null means the lock never engaged (no gen yet / legacy state): do not block. Once engaged,
  // any drift in generated/checks or gate.json flips this false and the gate fails closed.
  const enforcementLocked = state.enforcementHash === null || state.enforcementHash === enforcementHash(root)
  const gateCfg = validateGateConfig(JSON.parse(readFileSync(p.gate, 'utf8')), 'gate.json')
  // The repo check, fallow, the one shape-batch, and every non-shape invariant are mutually
  // independent processes, so they run concurrently. Each verdict is its own child's exit code;
  // the per-invariant list is re-sorted into model order afterward, so the report is identical
  // to the old serial run on every host.
  const shapes = model.invariants.filter((inv) => 'distinct' in inv.check)
  const others = model.invariants.filter((inv) => !('distinct' in inv.check))
  // Leave the parent thread and a core headroom; never drop below one worker.
  const limit = Math.max(1, (cpus().length || 3) - 2)
  const [repo, fallow, shapeResults, otherResults] = await Promise.all([
    runCheck(root, gateCfg.repoCheck),
    gateCfg.fallowCheck ? runCheck(root, gateCfg.fallowCheck) : Promise.resolve(null),
    runShapeBatch(p, root, shapes),
    pool(others, limit, async (inv) => {
      const cmd = invariantCmd(p, root, inv)
      if (cmd === null) return { id: inv.id, pass: false, detail: 'unknown check kind' }
      const r = await runCheck(root, cmd)
      return { id: inv.id, pass: r.pass, detail: r.out.slice(0, DETAIL_CAP) }
    }),
  ])
  const byId = new Map<string, { pass: boolean; detail: string }>()
  for (const [id, r] of shapeResults) byId.set(id, r)
  for (const r of otherResults) byId.set(r.id, { pass: r.pass, detail: r.detail })
  const invariants = model.invariants.map((inv) => {
    const r = byId.get(inv.id) ?? { pass: false, detail: 'no result' }
    return { id: inv.id, pass: r.pass, detail: r.detail }
  })
  const pass =
    modelHashLocked && enforcementLocked && repo.pass && (fallow?.pass ?? true) && invariants.every((i) => i.pass)
  return {
    pass,
    modelHashLocked,
    enforcementLocked,
    repoCheck: { cmd: gateCfg.repoCheck.join(' '), pass: repo.pass },
    fallow: fallow ? { cmd: gateCfg.fallowCheck!.join(' '), pass: fallow.pass } : null,
    invariants,
  }
}

// ---------- run report validation (hand-rolled, named paths in every error) ----------

function fail(path: string, msg: string): never {
  throw new VaderError(`invalid ${path}: ${msg}`)
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

function modelChangeOf(value: unknown, path: string): ModelChange {
  const m = obj(value, path)
  return {
    proposedBy: str(m.proposedBy, `${path}.proposedBy`),
    reason: str(m.reason, `${path}.reason`),
    diff: str(m.diff, `${path}.diff`),
  }
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

// ---------- machine-state validation (the .vader files vader itself writes, but which a
// human can hand-edit; we never trust a parse with an unchecked cast) ----------

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

function validateGateConfig(input: unknown, path: string): GateConfig {
  const g = obj(input, path)
  const out: GateConfig = {
    repoCheck: arr(g.repoCheck, `${path}.repoCheck`).map((x, i) => str(x, `${path}.repoCheck[${i}]`)),
  }
  if (g.fallowCheck !== undefined)
    out.fallowCheck = arr(g.fallowCheck, `${path}.fallowCheck`).map((x, i) => str(x, `${path}.fallowCheck[${i}]`))
  if (g.note !== undefined) out.note = str(g.note, `${path}.note`)
  return out
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

  const partitionBase = staleness(root, state.partition.commit, [])
  const staleSlices: { id: string; changed: string[] }[] = []
  if (state.partition.commit !== null && partitionBase.reason !== 'missing-commit') {
    const changed = changedSince(root, state.partition.commit)
    for (const slice of state.partition.slices) {
      const hits = changed.filter((f) => underWatch(f, slice.paths))
      if (hits.length > 0) staleSlices.push({ id: slice.id, changed: hits })
    }
  }
  const partitionStale = partitionBase.reason === 'no-stamp' || partitionBase.reason === 'missing-commit' || staleSlices.length > 0

  // key carries class+reason so a multi-word reason survives intact (no decode-by-split).
  const bounceCounts = new Map<string, { class: string; reason: string; count: number }>()
  for (const line of ledger) {
    if (line.type !== 'bounce') continue
    const key = `${line.class} ${line.reason}`
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
      reason: partitionStale ? (staleSlices.length > 0 ? 'watch-touched' : partitionBase.reason) : null,
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

// ---------- tick plan (the one fan-out every adapter consumes) ----------

// Why a slice gets more than one independent verifier. Carried so an adapter can show the
// operator the reason, and so the plan stays auditable rather than a bare number.
export type VoterReason = 'seam' | 'never-ratchet' | 'top-bounce' | 'default'
export type TickSlice = { id: string; class: string; voters: number; reason: VoterReason }

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
  const seamFirst: TickSlice[] = []
  const siblings: TickSlice[] = []
  for (const slice of recall.partition.slices) {
    const { voters, reason } = votersFor(slice.class, neverRatchet, bounced)
    const tick: TickSlice = { id: slice.id, class: slice.class, voters, reason }
    if (slice.class === 'seam') seamFirst.push(tick)
    else siblings.push(tick)
  }
  return { seamFirst, siblings }
}

// ---------- CLI ----------

const USAGE = `usage: vader <command> [args] [--root <dir>]

commands:
  init                                    scaffold .vader/ (idempotent); detect toolchain + fallow
  gen                                     compile the constitution model into .vader/generated/ checks
  gate                                    repo-check + fallow + invariant checks; JSON pass/fail by id
  recall                                  emit the verify-before-trust rehydration packet (JSON)
  triage [<risk-id> <action> --reason <text>]
                                          record a disposition (finding|defer|close); bare lists open risks
  persist <run-report.json>               close the loop: validate, gate on triage, append ledger, advance stamps
  ratchet [<class>] [--grant <level> --approved-by <name>]
                                          advisory autonomy verdicts; grant only with named human approval`

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const value = args[i + 1]
  // A flag with no value (end of args, or immediately followed by another --flag) must not
  // silently swallow the next flag as its value. Consume only the flag itself in that case.
  if (value === undefined || value.startsWith('--')) {
    args.splice(i, 1)
    return undefined
  }
  args.splice(i, 2)
  return value
}

// A grant level is an autonomy authorization, so a malformed --grant must fail loudly rather
// than coerce: Number('') is 0 and Number('x') is NaN, either of which would silently corrupt
// the ratchet. Accept only a non-negative integer.
export function parseGrant(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new VaderError(`--grant must be a non-negative integer, got: ${raw}`)
  return Number(raw)
}

async function main(argv: string[]): Promise<number> {
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
      case 'gen':
        print(await cmdGen(root))
        return 0
      case 'gate': {
        const r = await cmdGate(root)
        print(r)
        return r.pass ? 0 : 1
      }
      case 'recall':
        print(await cmdRecall(root))
        return 0
      case 'triage': {
        const [riskId, action] = rest
        if (riskId === undefined) {
          const state = loadState(root)
          print({ openRisks: state.risks.filter((r) => r.status === 'open'), pendingTriage: state.pendingTriage })
          return 0
        }
        if (action !== 'finding' && action !== 'defer' && action !== 'close')
          throw new VaderError('triage action must be finding, defer, or close')
        print(cmdTriage(root, riskId, action, reason ?? ''))
        return 0
      }
      case 'persist': {
        const [reportPath] = rest
        if (reportPath === undefined) throw new VaderError('persist requires a run-report.json path')
        print(cmdPersist(root, reportPath))
        return 0
      }
      case 'ratchet': {
        const [cls] = rest
        const opts = grant !== undefined ? { grant: parseGrant(grant), approvedBy: approvedBy ?? '' } : undefined
        print(cmdRatchet(root, cls, opts))
        return 0
      }
      default:
        process.stderr.write(`${USAGE}\n`)
        return 1
    }
  } catch (e) {
    process.stderr.write(`vader: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
