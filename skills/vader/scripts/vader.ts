#!/usr/bin/env bun
// vader: the deterministic spine of an app-agnostic software factory.
// One module. The CLI owns .vader/ state; the driving agent owns prose + runs/.
// Commands: init, gen, gate, recall, persist.
//
// The constitution model is the protected source of truth. vader gen compiles
// each invariant into a deterministic check in the target repo's toolchain;
// vader gate runs them and reports pass/fail keyed by invariant id. An id in the
// fail set is an automatic verifier bounce. The model is human-gated: a tick may
// PROPOSE a model change, it can never apply one.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
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

// ---------- factory state ----------

export type RoadmapStatus = 'pending' | 'in-progress' | 'done' | 'blocked'
export type RoadmapItem = { id: string; title: string; slicePaths: string[]; status: RoadmapStatus }

export type State = {
  version: 1
  modelHash: string | null
  roadmap: RoadmapItem[]
  risks: { id: string; desc: string; status: 'open' | 'closed' }[]
  pendingModelChange: { proposedBy: string; reason: string; diff: string } | null
  ratchet: { consecutiveCleanTicks: number }
}

const KINDS: InvariantKind[] = ['shape', 'dependency', 'behavioral', 'data']

export function validateConstitution(raw: unknown): Constitution {
  if (typeof raw !== 'object' || raw === null) throw new VaderError('constitution must be an object')
  const c = raw as Record<string, unknown>
  const invariants = c.invariants
  if (!Array.isArray(invariants)) throw new VaderError('constitution.invariants must be an array')
  const ids = new Set<string>()
  for (const inv of invariants) {
    const i = inv as Record<string, unknown>
    if (typeof i.id !== 'string' || i.id === '') throw new VaderError('invariant id required')
    if (ids.has(i.id)) throw new VaderError(`duplicate invariant id ${i.id}`)
    ids.add(i.id)
    const isEscape =
      typeof i.check === 'object' && i.check !== null && 'rawCheck' in (i.check as object)
    if (!isEscape && !KINDS.includes(i.kind as InvariantKind))
      throw new VaderError(
        `invariant ${i.id}: kind must be one of ${KINDS.join(', ')} (or use an escape rawCheck)`,
      )
  }
  return raw as Constitution
}

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
  }
}

function defaultState(): State {
  return {
    version: 1,
    modelHash: null,
    roadmap: [],
    risks: [],
    pendingModelChange: null,
    ratchet: { consecutiveCleanTicks: 0 },
  }
}

export function loadState(root: string): State {
  const p = paths(root)
  if (!existsSync(p.state)) throw new VaderError(`no factory state at ${p.state}; run "vader init" first`)
  return JSON.parse(readFileSync(p.state, 'utf8')) as State
}

function saveState(root: string, state: State): void {
  const p = paths(root)
  const tmp = `${p.state}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  renameSync(tmp, p.state)
}

export function hashModel(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

// Reads the model: prefers the JSON form (machine truth); falls back to importing
// the TS form under bun for repos that author it in TS. Returns the parsed
// constitution AND the raw text the hash is taken over.
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

// ---------- toolchain detection ----------

export type Gate = { repoCheck: string[]; note?: string }

export function detectGate(root: string): Gate {
  if (existsSync(join(root, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    if (pkg.scripts?.check) return { repoCheck: ['bun', 'run', 'check'] }
    if (existsSync(join(root, 'tsconfig.json'))) return { repoCheck: ['bunx', 'tsc', '--noEmit'] }
    return { repoCheck: ['bun', 'test'] }
  }
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'setup.py')))
    return { repoCheck: ['pytest', '-q'] }
  if (existsSync(join(root, 'Cargo.toml'))) return { repoCheck: ['cargo', 'check'] }
  if (existsSync(join(root, 'go.mod'))) return { repoCheck: ['go', 'build', './...'] }
  return {
    repoCheck: ['echo', 'TODO: set repoCheck in .vader/gate.json'],
    note: 'no toolchain detected; fill in the real check command',
  }
}

export function cmdInit(root: string): { created: string[]; gate: Gate } {
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

// A generated dependency check: a standalone bun script that scans `from` files
// for imports matching `to` and exits nonzero on any violation.
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

// A generated data-law check: seeded-input property test, zero-dep.
// The repo provides .vader/laws/law-<id>.ts exporting law(input): boolean.
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

// A generated shape check (TS gold path): branded nominal types + a type-level
// test whose @ts-expect-error lines FAIL to compile if the distinction is lost.
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

export async function cmdGen(root: string): Promise<{ written: string[] }> {
  const p = paths(root)
  const { model } = await readModel(root)
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
  return { written }
}

// ---------- gate ----------

export type GateResult = {
  pass: boolean
  modelHashLocked: boolean
  repoCheck: { cmd: string; pass: boolean } | null
  invariants: { id: string; pass: boolean; detail: string }[]
}

function runCheck(root: string, cmd: string[]): { pass: boolean; detail: string } {
  const head = cmd[0]
  if (head === undefined) return { pass: false, detail: 'empty command' }
  try {
    const out = execFileSync(head, cmd.slice(1), { cwd: root, encoding: 'utf8' })
    return { pass: true, detail: out.slice(0, 400) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { pass: false, detail: (err.stderr || err.stdout || err.message || 'failed').slice(0, 400) }
  }
}

export async function cmdGate(root: string): Promise<GateResult> {
  const p = paths(root)
  const state = loadState(root)
  const { model, raw } = await readModel(root)
  const modelHashLocked = state.modelHash === null || state.modelHash === hashModel(raw)
  const gateCfg = JSON.parse(readFileSync(p.gate, 'utf8')) as Gate
  const repo = runCheck(root, gateCfg.repoCheck)
  const invariants: { id: string; pass: boolean; detail: string }[] = []
  for (const inv of model.invariants) {
    let r: { pass: boolean; detail: string }
    if ('rawCheck' in inv.check) r = runCheck(root, ['bash', '-c', inv.check.rawCheck])
    else if ('forbidImport' in inv.check)
      r = runCheck(root, ['bun', join(p.generated, 'checks', `dep-${inv.id}.ts`), root])
    else if ('law' in inv.check)
      r = runCheck(root, ['bun', 'test', join(p.generated, 'checks', `data-${inv.id}.test.ts`)])
    else if ('distinct' in inv.check)
      r = runCheck(root, [
        'bunx',
        'tsc',
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        join(p.generated, 'checks', `shape-${inv.id}.neg.ts`),
      ])
    else if ('contractTest' in inv.check)
      r = runCheck(root, ['bun', 'test', join(p.generated, 'checks', `behavioral-${inv.id}.test.ts`)])
    else r = { pass: false, detail: 'unknown check kind' }
    invariants.push({ id: inv.id, pass: r.pass, detail: r.detail })
  }
  const pass = modelHashLocked && repo.pass && invariants.every((i) => i.pass)
  return {
    pass,
    modelHashLocked,
    repoCheck: { cmd: gateCfg.repoCheck.join(' '), pass: repo.pass },
    invariants,
  }
}

// ---------- recall + persist ----------

export async function cmdRecall(root: string): Promise<unknown> {
  const state = loadState(root)
  let modelOk = false
  let invariantCount = 0
  try {
    const { model } = await readModel(root)
    modelOk = true
    invariantCount = model.invariants.length
  } catch {
    // model may be absent before P0; recall still works so the loop can bootstrap.
  }
  const next = state.roadmap.find((r) => r.status === 'pending') ?? null
  return {
    modelHash: state.modelHash,
    modelOk,
    invariantCount,
    roadmap: state.roadmap.map((r) => ({ id: r.id, status: r.status })),
    nextItem: next,
    openRisks: state.risks.filter((r) => r.status === 'open'),
    pendingModelChange: state.pendingModelChange,
    ratchet: state.ratchet,
  }
}

export type TickReport = {
  itemId: string
  gate: GateResult
  newRisks?: { id: string; desc: string }[]
  modelChange?: { proposedBy: string; reason: string; diff: string }
}

export function cmdPersist(root: string, report: TickReport): { ok: true; item: RoadmapItem } {
  const state = loadState(root)
  const item = state.roadmap.find((r) => r.id === report.itemId)
  if (item === undefined) throw new VaderError(`unknown roadmap item ${report.itemId}`)
  // anti-decay: a tick may PROPOSE a model change, never apply it.
  if (report.modelChange) {
    state.pendingModelChange = report.modelChange
    item.status = 'blocked'
  } else if (report.gate.pass) {
    item.status = 'done'
    state.ratchet.consecutiveCleanTicks += 1
  } else {
    item.status = 'blocked'
    state.ratchet.consecutiveCleanTicks = 0
  }
  for (const r of report.newRisks ?? [])
    if (!state.risks.some((x) => x.id === r.id))
      state.risks.push({ id: r.id, desc: r.desc, status: 'open' })
  appendFileSync(
    paths(root).ledger,
    JSON.stringify({
      type: 'tick',
      itemId: report.itemId,
      gatePass: report.gate.pass,
      failed: report.gate.invariants.filter((i) => !i.pass).map((i) => i.id),
    }) + '\n',
  )
  saveState(root, state)
  return { ok: true, item }
}

// ---------- CLI ----------

const USAGE = `usage: vader <command> [--root <dir>]

commands:
  init                   scaffold .vader/ (idempotent); detects toolchain, stubs gate.json
  gen                    compile the constitution model into .vader/generated/ checks
  gate                   run repo-check + invariant checks; JSON pass/fail by invariant id
  recall                 emit the tick rehydration packet (JSON)
  persist <report.json>  close a tick: mark item, park model proposals, append ledger`

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv]
  const root = flag(args, '--root') ?? process.cwd()
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
      case 'persist': {
        const [reportPath] = rest
        if (reportPath === undefined) throw new VaderError('persist requires a report.json path')
        print(cmdPersist(root, JSON.parse(readFileSync(reportPath, 'utf8')) as TickReport))
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
