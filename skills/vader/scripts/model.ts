// vader model: the protected constitution and how it compiles to enforced checks. The model is
// a human-gated, hash-locked artifact; `cmdGen` compiles each invariant into a deterministic
// check under .vader/generated/ and locks two hashes (the model text, and the compiled surface)
// so a later hand-edit fails the gate closed. Reading and hashing the model lives here too,
// because integrity is a model concern.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { VaderError, paths, loadState, saveState } from './core.ts'

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
  // The compiled checks AND the repo-supplied law bodies those data checks import. A data check
  // is only as honest as its law(): locking the generated test but not the law it calls would
  // leave a tautological `law = () => true` free to pass. laws/ is authored at constitution time
  // so it is present at gen and safe to lock; contracts/ is deliberately excluded (the owner
  // writes a behavioral harness AFTER gen, so locking it would trip the gate on legitimate work,
  // which is why behavioral honesty rests on its red fixture at gate time, not on this lock).
  for (const dir of [join(p.generated, 'checks'), p.laws]) {
    for (const f of listFilesSorted(dir)) {
      // Hash the POSIX-normalized relative path so the lock is identical whether gen ran on a
      // '/'-separator host or a '\\'-separator one. relative() yields native separators; left raw,
      // the same checkout would lock to different hashes on macOS vs Windows.
      parts.push(relative(root, f).split(sep).join('/') + '\0' + readFileSync(f, 'utf8'))
    }
  }
  const gateRaw = existsSync(p.gate) ? readFileSync(p.gate, 'utf8') : ''
  parts.push('gate.json\0' + gateRaw)
  // Fold in the enforcement-relevant config subset (named tsconfig strict flags + the resolved
  // repoCheck script body). repoCheck runs the repo's own toolchain, so weakening a strict flag
  // or gutting the check script would defang the gate while it stayed green; the fingerprint
  // makes that edit flip enforcementLocked exactly like editing a generated check.
  parts.push('config\0' + configFingerprint(root, gateRaw))
  return hashModel(parts.join('\0\0'))
}

// The enforcement-relevant slice of the repo's own toolchain config, fingerprinted so the lock
// covers what repoCheck reads without hashing whole config files (a benign unrelated edit, a new
// path alias or a formatting rule, must not false-fail the gate). We fingerprint ONLY the strict
// flags named in gate.json (default: `strict`) and the body of the exact package.json script that
// repoCheck invokes. Kept in model.ts, operating on the raw gate.json text, so this module stays
// the single home of integrity and does not import the gate module (which would cycle).
export function configFingerprint(root: string, gateRaw: string): string {
  const cfg = parseJsonObject(gateRaw)
  const named = strArray(cfg['strictFlags'])
  const flags = named.length > 0 ? named : ['strict']
  const opts = readCompilerOptions(root)
  const parts: string[] = []
  for (const f of [...flags].sort()) parts.push(`ts:${f}=${JSON.stringify(opts[f] ?? null)}`)
  const script = resolveRepoCheckScript(root, strArray(cfg['repoCheck']))
  if (script !== null) parts.push(`script:${script.name}=${script.body}`)
  return hashModel(parts.join('\0'))
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
}

function readCompilerOptions(root: string): Record<string, unknown> {
  const fp = join(root, 'tsconfig.json')
  if (!existsSync(fp)) return {}
  // Reads this repo's OWN compilerOptions only: `extends` is not resolved, so a strict flag
  // inherited from a base config is not covered. A tsconfig with comments (jsonc) will not parse
  // either; we degrade to {} so every named flag reads as null. Both are stable across gen and gate
  // (no false-fail), they just leave that flag unprotected. See references/constitution.md, the
  // "Config-fingerprint floor" note.
  const parsed = parseJsonObject(readFileSync(fp, 'utf8'))
  const opts = parsed['compilerOptions']
  return typeof opts === 'object' && opts !== null && !Array.isArray(opts) ? (opts as Record<string, unknown>) : {}
}

// If repoCheck runs a named package.json script (`<runner> run <name>`), return that script's
// resolved body so rewriting it (e.g. to `echo ok`) flips the fingerprint. A direct command
// (e.g. `bunx tsc --noEmit`) has no script body to resolve and returns null.
function resolveRepoCheckScript(root: string, repoCheck: string[]): { name: string; body: string } | null {
  const runIdx = repoCheck.indexOf('run')
  if (runIdx === -1) return null
  const name = repoCheck[runIdx + 1]
  if (name === undefined) return null
  const fp = join(root, 'package.json')
  if (!existsSync(fp)) return null
  const scripts = parseJsonObject(readFileSync(fp, 'utf8'))['scripts']
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return null
  const body = (scripts as Record<string, unknown>)[name]
  return typeof body === 'string' ? { name, body } : null
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

// Render human-authored free text (a law/statement/relation description) as a single-line comment
// tail. A newline would otherwise escape the `//` comment and turn prose into a top-level statement
// in the generated check; a bare `\r` splits it in the same way. Test titles use JSON.stringify for
// the same reason (a valid string literal regardless of quotes or newlines in the text).
const commentText = (s: string): string => s.replace(/[\r\n]+/g, ' ')

// A generated data-law check: seeded-input property test, zero-dep. The repo provides
// .vader/laws/law-<id>.ts exporting law(input): boolean, AND a red fixture
// .vader/laws/law-<id>.neg.ts exporting `violating`: a known-bad input the law MUST reject.
// The red fixture is the teeth: a check that can never fail is hollow, so the gate proves this
// one can. A tautological `law = () => true` passes the property test but fails the red-fixture
// test (it accepts a value it must reject); a missing fixture leaves the import red, by design.
function genData(inv: Invariant, check: DataCheck): { file: string; body: string } {
  const lawImport = `../../laws/law-${inv.id}.ts`
  const negImport = `../../laws/law-${inv.id}.neg.ts`
  const body = `import { test, expect } from 'bun:test'
// GENERATED by vader from invariant ${inv.id}. Do not edit.
// LAW: ${commentText(check.law)}
import { law } from '${lawImport}'
import { violating } from '${negImport}'
function* seeded(seed, count, kind) {
  let s = seed
  for (let i = 0; i < count; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    yield kind === 'int' ? s % 100000 : 'k' + (s % 1000)
  }
}
test(${JSON.stringify(`${inv.id}: ${check.law}`)}, () => {
  for (const input of seeded(1, ${check.sample.count}, '${check.sample.kind}')) {
    expect(law(input)).toBe(true)
  }
})
// Red fixture: the law MUST reject its known-violating input. This is what forces the law to be
// real; a check that cannot fail earns none of the gold-path guarantees.
test('${inv.id}: law rejects its red fixture', () => {
  expect(law(violating)).toBe(false)
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
// ${commentText(check.relation ?? `relation: pointInInterval(p: ${A}, iv: ${B})`)}
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
// CONTRACT: ${commentText(inv.statement)}
// The owner must provide .vader/contracts/${check.contractTest}.ts exporting
//   run(): { outcomePreserved: boolean }
import { run } from '${harnessImport}'
test(${JSON.stringify(`${inv.id}: ${inv.statement}`)}, () => {
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
