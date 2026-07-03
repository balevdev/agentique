import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  VaderError,
  validateConstitution,
  validateReport,
  hashModel,
  paths,
  loadState,
  cmdInit,
  cmdGen,
  cmdGate,
  cmdPersist,
  cmdTriage,
  cmdRatchet,
  cmdRecall,
  globToRegExp,
  flag,
  parseGrant,
  planTick,
  type RunReport,
  type State,
  type RecallPacket,
} from './vader.ts'

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), 'vader-'))
}

function gitRepo(): { root: string; c0: string } {
  const root = tmpRepo()
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# r\n')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'c0'], { cwd: root })
  const c0 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  return { root, c0 }
}

function commit(root: string, file: string, body: string, msg: string): string {
  const full = join(root, file)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: root })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

function patchState(root: string, fn: (s: State) => void): void {
  const s = loadState(root)
  fn(s)
  writeFileSync(paths(root).state, JSON.stringify(s, null, 2))
}

// A minimal valid review-mode run report touching one class, all-green by default.
function report(over: { run: Partial<RunReport['run']> } & Partial<Omit<RunReport, 'run'>>): RunReport {
  return {
    run: {
      id: over.run.id ?? 'R1',
      mode: over.run.mode ?? 'review',
      spec: over.run.spec ?? 'spec',
      commitRange: over.run.commitRange ?? 'c0..HEAD',
      gate: over.run.gate ?? 'green',
    },
    itemId: over.itemId,
    slices: over.slices ?? [{ id: 'S1', class: 'logic', owner: 'o', verdict: 'accept', bounces: [] }],
    risks: over.risks ?? { new: [], dispositions: [] },
    decisions: over.decisions ?? [],
    conventions: over.conventions ?? [],
    stamps: over.stamps,
    modelChange: over.modelChange,
  }
}

// ---------- validateConstitution ----------

test('validateConstitution rejects an invariant with an unknown kind', () => {
  const bad = {
    concepts: {},
    invariants: [{ id: 'X', kind: 'nope', statement: 's', check: { distinct: ['A', 'B'] } }],
  }
  expect(() => validateConstitution(bad)).toThrow(VaderError)
})

test('validateConstitution accepts a well-formed dependency invariant', () => {
  const ok = {
    concepts: {},
    invariants: [
      { id: 'INV-dep', kind: 'dependency', statement: 's', check: { forbidImport: { from: 'a/**', to: 'b/**' } } },
    ],
  }
  expect(validateConstitution(ok).invariants.length).toBe(1)
})

test('validateConstitution allows an escape rawCheck without a known kind', () => {
  const ok = {
    concepts: {},
    invariants: [{ id: 'INV-raw', kind: 'whatever', statement: 's', check: { rawCheck: 'true' } }],
  }
  expect(validateConstitution(ok).invariants.length).toBe(1)
})

test('validateConstitution rejects duplicate ids', () => {
  const bad = {
    concepts: {},
    invariants: [
      { id: 'DUP', kind: 'data', statement: 's', check: { rawCheck: 'true' } },
      { id: 'DUP', kind: 'data', statement: 's', check: { rawCheck: 'true' } },
    ],
  }
  expect(() => validateConstitution(bad)).toThrow(/duplicate/)
})

test('validateConstitution rejects an id that would escape a generated filename', () => {
  const bad = {
    concepts: {},
    invariants: [{ id: '../evil', kind: 'data', statement: 's', check: { rawCheck: 'true' } }],
  }
  expect(() => validateConstitution(bad)).toThrow(/id must match/)
})

test('validateConstitution rejects a distinct name that is not a TS identifier', () => {
  const bad = {
    concepts: {},
    invariants: [{ id: 'pt', kind: 'shape', statement: 's', check: { distinct: ['Temporal Point', 'B'] } }],
  }
  expect(() => validateConstitution(bad)).toThrow(/TS identifier/)
})

// ---------- flag + parseGrant (arg parsing safety) ----------

test('flag does not swallow the next flag as its value', () => {
  const args = ['--grant', '--approved-by', 'human']
  expect(flag(args, '--grant')).toBeUndefined()
  expect(args).toEqual(['--approved-by', 'human'])
})

test('flag returns the value and consumes both tokens for a normal flag', () => {
  const args = ['--grant', '3', 'tail']
  expect(flag(args, '--grant')).toBe('3')
  expect(args).toEqual(['tail'])
})

test('parseGrant accepts a non-negative integer and rejects everything else', () => {
  expect(parseGrant('0')).toBe(0)
  expect(parseGrant('2')).toBe(2)
  expect(() => parseGrant('')).toThrow(/non-negative integer/)
  expect(() => parseGrant('x')).toThrow(/non-negative integer/)
  expect(() => parseGrant('-1')).toThrow(/non-negative integer/)
  expect(() => parseGrant('1.5')).toThrow(/non-negative integer/)
})

// ---------- hash + glob ----------

test('hashModel is deterministic and 32 chars', () => {
  expect(hashModel('abc')).toBe(hashModel('abc'))
  expect(hashModel('abc').length).toBe(32)
  expect(hashModel('abc')).not.toBe(hashModel('abd'))
})

test('globToRegExp handles ** and produces a valid double-slash-escaped literal', () => {
  const re = globToRegExp('a/**')
  expect(re.test('a/x.ts')).toBe(true)
  expect(re.test('a/deep/x.ts')).toBe(true)
  expect(re.test('b/x.ts')).toBe(false)
  expect(re.toString()).toContain('\\/')
})

// ---------- AC1: init (merged scaffold, idempotent) ----------

test('cmdInit scaffolds the merged .vader and is idempotent', () => {
  const root = tmpRepo()
  const first = cmdInit(root)
  expect(first.created).toContain('.vader/state.json')
  expect(first.created).toContain('.vader/LEDGER.jsonl')
  expect(first.created).toContain('.vader/GROUNDING.md')
  expect(first.created).toContain('.vader/DECISIONS.md')
  expect(first.created).toContain('.vader/CONVENTIONS.md')
  const s = loadState(root)
  expect(s.version).toBe(1)
  expect(s.ratchet.neverRatchet).toContain('seam')
  expect(s.grounding.commit).toBeNull()
  const second = cmdInit(root)
  expect(second.created).not.toContain('.vader/state.json')
})

test('detectGate falls back to a stub when no toolchain', () => {
  const root = tmpRepo()
  const gate = cmdInit(root).gate
  expect(gate.repoCheck[0]).toBe('echo')
  expect(gate.note).toContain('no toolchain')
})

// ---------- AC9: fallow is only wired when configured ----------

test('detectGate omits fallowCheck when no .fallowrc is present', () => {
  const root = tmpRepo()
  const gate = cmdInit(root).gate
  expect(gate.fallowCheck).toBeUndefined()
})

// ---------- AC2 + AC5(router): gen dependency floor ----------

test('cmdGen emits a dependency check that fails on a real violation', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(
    paths(root).modelJson,
    JSON.stringify({
      concepts: {},
      invariants: [
        { id: 'INV-dep', kind: 'dependency', statement: 'a !-> b', check: { forbidImport: { from: 'a/**', to: 'b/**' } } },
      ],
    }),
  )
  const res = await cmdGen(root)
  expect(res.written.some((f) => f.includes('dep-INV-dep'))).toBe(true)
  mkdirSync(join(root, 'a'), { recursive: true })
  writeFileSync(join(root, 'a', 'x.ts'), "import { z } from 'b/y'\n")
  let failed = false
  try {
    execFileSync('bun', [join(paths(root).generated, 'checks', 'dep-INV-dep.ts'), root], { encoding: 'utf8' })
  } catch {
    failed = true
  }
  expect(failed).toBe(true)
})

test('cmdGen dependency check passes when there is no violation', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(
    paths(root).modelJson,
    JSON.stringify({
      concepts: {},
      invariants: [
        { id: 'INV-dep', kind: 'dependency', statement: 'a !-> b', check: { forbidImport: { from: 'a/**', to: 'b/**' } } },
      ],
    }),
  )
  await cmdGen(root)
  mkdirSync(join(root, 'a'), { recursive: true })
  writeFileSync(join(root, 'a', 'x.ts'), "import { z } from 'c/ok'\n")
  const out = execFileSync('bun', [join(paths(root).generated, 'checks', 'dep-INV-dep.ts'), root], { encoding: 'utf8' })
  expect(out).toContain('ok')
})

test('cmdGen shape: neg file typechecks, proving the distinction holds', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(
    paths(root).modelJson,
    JSON.stringify({
      concepts: {},
      invariants: [
        { id: 'pt', kind: 'shape', statement: 'point is not interval', check: { distinct: ['TemporalPoint', 'TemporalInterval'] } },
      ],
    }),
  )
  await cmdGen(root)
  const checks = join(paths(root).generated, 'checks')
  let ok = true
  try {
    execFileSync('bunx', ['tsc', '--noEmit', '--strict', '--skipLibCheck', join(checks, 'shape-pt.neg.ts')], { encoding: 'utf8' })
  } catch {
    ok = false
  }
  expect(ok).toBe(true)
})

// ---------- AC3: gate ----------

test('cmdGate fails and names the violated invariant id', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  writeFileSync(
    paths(root).modelJson,
    JSON.stringify({
      concepts: {},
      invariants: [
        { id: 'INV-dep', kind: 'dependency', statement: 'a !-> b', check: { forbidImport: { from: 'a/**', to: 'b/**' } } },
      ],
    }),
  )
  await cmdGen(root)
  mkdirSync(join(root, 'a'), { recursive: true })
  writeFileSync(join(root, 'a', 'x.ts'), "import { z } from 'b/y'\n")
  const res = await cmdGate(root)
  expect(res.pass).toBe(false)
  expect(res.invariants.find((i) => i.id === 'INV-dep')?.pass).toBe(false)
})

test('cmdGate passes when repoCheck is trivial and the model is empty; fallow is null when unconfigured', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  writeFileSync(paths(root).modelJson, JSON.stringify({ concepts: {}, invariants: [] }))
  const res = await cmdGate(root)
  expect(res.pass).toBe(true)
  expect(res.fallow).toBeNull()
})

test('AC3/AC9: a configured-but-failing fallowCheck fails the gate, never a silent pass', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'], fallowCheck: ['false'] }))
  writeFileSync(paths(root).modelJson, JSON.stringify({ concepts: {}, invariants: [] }))
  const res = await cmdGate(root)
  expect(res.fallow?.pass).toBe(false)
  expect(res.pass).toBe(false)
})

test('AC8: cmdGate fails closed when the model hash is unlocked', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  writeFileSync(paths(root).modelJson, JSON.stringify({ concepts: {}, invariants: [] }))
  patchState(root, (s) => {
    s.modelHash = 'deadbeef'
  })
  const res = await cmdGate(root)
  expect(res.modelHashLocked).toBe(false)
  expect(res.pass).toBe(false)
})

// ---------- AC-lock: the enforcement surface (generated checks + gate.json) ----------

test('AC-lock: tampering a generated check fails the gate even with the model hash locked', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  writeFileSync(
    paths(root).modelJson,
    JSON.stringify({
      concepts: {},
      invariants: [
        { id: 'INV-dep', kind: 'dependency', statement: 'a !-> b', check: { forbidImport: { from: 'a/**', to: 'b/**' } } },
      ],
    }),
  )
  await cmdGen(root)
  expect((await cmdGate(root)).pass).toBe(true)
  // an agent neuters the COMPILED check without touching the protected model
  writeFileSync(join(paths(root).generated, 'checks', 'dep-INV-dep.ts'), '#!/usr/bin/env bun\nprocess.exit(0)\n')
  const res = await cmdGate(root)
  expect(res.modelHashLocked).toBe(true)
  expect(res.enforcementLocked).toBe(false)
  expect(res.pass).toBe(false)
})

test('AC-lock: silencing repoCheck via gate.json after gen fails closed', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['false'] }))
  writeFileSync(paths(root).modelJson, JSON.stringify({ concepts: {}, invariants: [] }))
  await cmdGen(root)
  // an agent rewrites the repo check to a no-op to silence the gate after the lock engaged
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  const res = await cmdGate(root)
  expect(res.enforcementLocked).toBe(false)
  expect(res.pass).toBe(false)
})

test('AC-lock: gen then gate is green with enforcementLocked true', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  writeFileSync(paths(root).modelJson, JSON.stringify({ concepts: {}, invariants: [] }))
  await cmdGen(root)
  const res = await cmdGate(root)
  expect(res.enforcementLocked).toBe(true)
  expect(res.pass).toBe(true)
})

test('AC-lock: a never-genned repo treats the enforcement lock as not engaged (legacy/null path)', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  writeFileSync(paths(root).modelJson, JSON.stringify({ concepts: {}, invariants: [] }))
  // no cmdGen: enforcementHash stays null, so the lock must not block a fresh repo
  const res = await cmdGate(root)
  expect(res.enforcementLocked).toBe(true)
  expect(res.pass).toBe(true)
})

test('AC-lock: re-gen after a gate.json change re-locks the enforcement surface', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['false'] }))
  writeFileSync(paths(root).modelJson, JSON.stringify({ concepts: {}, invariants: [] }))
  await cmdGen(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  expect((await cmdGate(root)).enforcementLocked).toBe(false)
  await cmdGen(root) // operator re-gens after deliberately editing the verdict config
  const res = await cmdGate(root)
  expect(res.enforcementLocked).toBe(true)
  expect(res.pass).toBe(true)
})

// ---------- law lock + data red fixture (hollow-pass teeth) ----------

// A data invariant, its real law, and its red fixture, all present at gen so the law is locked.
function genDataRepo(root: string, law: string, violating: string): void {
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  mkdirSync(join(root, '.vader', 'laws'), { recursive: true })
  writeFileSync(join(root, '.vader', 'laws', 'law-D.ts'), law)
  writeFileSync(join(root, '.vader', 'laws', 'law-D.neg.ts'), violating)
  writeFileSync(
    paths(root).modelJson,
    JSON.stringify({
      concepts: {},
      invariants: [{ id: 'D', kind: 'data', statement: 'non-negative', check: { law: 'x >= 0', sample: { kind: 'int', count: 10 } } }],
    }),
  )
}

test('law-lock: editing a locked law body after gen flips enforcementLocked and fails the gate', async () => {
  const root = tmpRepo()
  genDataRepo(root, 'export const law = (x: number): boolean => x >= 0\n', 'export const violating = -1\n')
  await cmdGen(root)
  expect((await cmdGate(root)).pass).toBe(true)
  // an agent rewrites the repo-supplied law to a tautology to pass hollow; the lock now covers it
  writeFileSync(join(root, '.vader', 'laws', 'law-D.ts'), 'export const law = (_x: number): boolean => true\n')
  const res = await cmdGate(root)
  expect(res.enforcementLocked).toBe(false)
  expect(res.pass).toBe(false)
})

test('data red fixture: a tautological law present at gen still fails the gate, lock satisfied', async () => {
  const root = tmpRepo()
  // the hollow law is locked in AS-IS, so enforcementLocked stays true: the RED FIXTURE is what
  // bites. A law that accepts its known-violating input cannot be a real check.
  genDataRepo(root, 'export const law = (_x: number): boolean => true\n', 'export const violating = -1\n')
  await cmdGen(root)
  const res = await cmdGate(root)
  expect(res.enforcementLocked).toBe(true)
  expect(res.invariants.find((i) => i.id === 'D')?.pass).toBe(false)
  expect(res.pass).toBe(false)
})

test('gen: free-text in a law description cannot break out of the generated comment or title', async () => {
  const root = tmpRepo()
  // a human writes a multi-line law description carrying a quote and what looks like code. Rendered
  // raw, the newline escapes the `// LAW:` comment and the single-quoted test title, turning prose
  // into a top-level statement (uncompilable at best, executed under `bun test` at worst).
  const nastyLaw = "x >= 0\nprocess.exit(1) // O'Brien says hi"
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  mkdirSync(join(root, '.vader', 'laws'), { recursive: true })
  writeFileSync(join(root, '.vader', 'laws', 'law-D.ts'), 'export const law = (x: number): boolean => x >= 0\n')
  writeFileSync(join(root, '.vader', 'laws', 'law-D.neg.ts'), 'export const violating = -1\n')
  writeFileSync(
    paths(root).modelJson,
    JSON.stringify({
      concepts: {},
      invariants: [{ id: 'D', kind: 'data', statement: 'non-negative', check: { law: nastyLaw, sample: { kind: 'int', count: 5 } } }],
    }),
  )
  await cmdGen(root)
  const gen = readFileSync(join(root, '.vader', 'generated', 'checks', 'data-D.test.ts'), 'utf8')
  expect(gen).not.toMatch(/^process\.exit/m) // the newline never became a top-level statement
  expect((await cmdGate(root)).pass).toBe(true) // the file still compiles and the real law passes
})

// ---------- config-subset lock (defang-the-toolchain teeth) ----------

test('config-lock: weakening tsconfig strict after gen fails the gate', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  writeFileSync(paths(root).modelJson, JSON.stringify({ concepts: {}, invariants: [] }))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
  await cmdGen(root)
  expect((await cmdGate(root)).pass).toBe(true)
  // an agent defangs the strongest static checks by turning off strict, gate stays green otherwise
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: false } }))
  const res = await cmdGate(root)
  expect(res.enforcementLocked).toBe(false)
  expect(res.pass).toBe(false)
})

test('config-lock: a benign unrelated tsconfig edit does NOT fail the gate (false-positive guard)', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  writeFileSync(paths(root).modelJson, JSON.stringify({ concepts: {}, invariants: [] }))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
  await cmdGen(root)
  // add an unrelated path alias: only the named strict flags are fingerprinted, so this is benign
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } } }))
  const res = await cmdGate(root)
  expect(res.enforcementLocked).toBe(true)
  expect(res.pass).toBe(true)
})

test('config-lock: rewriting the repoCheck script body after gen fails the gate', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { check: 'true' } }))
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['bun', 'run', 'check'] }))
  writeFileSync(paths(root).modelJson, JSON.stringify({ concepts: {}, invariants: [] }))
  await cmdGen(root)
  expect((await cmdGate(root)).pass).toBe(true)
  // an agent guts the check script to a no-op; repoCheck still exits 0, the fingerprint catches it
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { check: 'echo defanged' } }))
  const res = await cmdGate(root)
  expect(res.enforcementLocked).toBe(false)
  expect(res.pass).toBe(false)
})

// ---------- structural-debt ratchet ----------

test('debt: a tick that adds a runtime dependency is refused at persist', () => {
  const root = tmpRepo()
  cmdInit(root)
  expect(cmdPersist(root, report({ run: { id: 'R1' } })).debt).toBe(0) // baseline
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '1.0.0' } }))
  expect(() => cmdPersist(root, report({ run: { id: 'R2' } }))).toThrow(/structural debt would rise/)
})

test('debt: a routed model change raises the baseline, permitting the rise', () => {
  const root = tmpRepo()
  cmdInit(root)
  cmdPersist(root, report({ run: { id: 'R1' } }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '1.0.0' } }))
  const res = cmdPersist(root, report({ run: { id: 'R2' }, modelChange: { proposedBy: 'p', reason: 'need dep', diff: '+dep' } }))
  expect(res.debt).toBe(1)
})

test('debt: a tick that lowers debt is accepted', () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '1.0.0' } }))
  expect(cmdPersist(root, report({ run: { id: 'R1' }, modelChange: { proposedBy: 'p', reason: 'seed', diff: '+dep' } })).debt).toBe(1)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }))
  expect(cmdPersist(root, report({ run: { id: 'R2' } })).debt).toBe(0)
})

test('debt: the first persist on a repo that already carries debt records a baseline, not a refusal', () => {
  const root = tmpRepo()
  cmdInit(root)
  // Vader is adopted on a real repo that already has runtime deps and a source directory. The very
  // first tick has NO previous run-line to ratchet against, so it must record the existing debt as
  // the baseline rather than compare it to an imaginary zero and refuse. (Regression: prevDebt used
  // to default to 0, so the first persist on any populated repo threw "structural debt would rise".)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '1.0.0', ms: '2.0.0' } }))
  mkdirSync(join(root, 'src'))
  const res = cmdPersist(root, report({ run: { id: 'R1' } }))
  expect(res.debt).toBe(3) // 2 runtime deps + 1 top-level dir
})

test('debt: an untracked build-output directory is not structural debt (git-tracked dirs only)', () => {
  const { root } = gitRepo() // README.md tracked at root, no tracked top-level directories
  cmdInit(root)
  expect(cmdPersist(root, report({ run: { id: 'R1' } })).debt).toBe(0) // baseline
  // a build step drops a gitignored output directory between ticks; it is not part of the source
  // structure the "no new top-level directory" rule protects, so it must not inflate debt.
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'dist', 'bundle.js'), '// built artifact, untracked\n')
  expect(cmdPersist(root, report({ run: { id: 'R2' } })).debt).toBe(0)
})

// ---------- gate: batched-shape attribution + model-order preservation ----------

test('cmdGate preserves model order and attributes a batched shape failure to its own id only', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  mkdirSync(join(root, '.vader', 'laws'), { recursive: true })
  writeFileSync(join(root, '.vader', 'laws', 'law-d1.ts'), 'export const law = (x: number): boolean => x >= 0\n')
  writeFileSync(join(root, '.vader', 'laws', 'law-d1.neg.ts'), 'export const violating = -1\n')
  writeFileSync(
    paths(root).modelJson,
    JSON.stringify({
      concepts: {},
      invariants: [
        { id: 'shapeA', kind: 'shape', statement: 's', check: { distinct: ['PointA', 'IntervalA'] } },
        { id: 'd1', kind: 'data', statement: 's', check: { law: 'x >= 0', sample: { kind: 'int', count: 10 } } },
        { id: 'shapeB', kind: 'shape', statement: 's', check: { distinct: ['PointB', 'IntervalB'] } },
      ],
    }),
  )
  await cmdGen(root)
  const clean = await cmdGate(root)
  // model order is preserved regardless of which checks finish first
  expect(clean.invariants.map((i) => i.id)).toEqual(['shapeA', 'd1', 'shapeB'])
  expect(clean.invariants.every((i) => i.pass)).toBe(true)
  // break only shapeA's compiled check; the batched tsc must fail shapeA and still pass shapeB
  writeFileSync(join(paths(root).generated, 'checks', 'shape-shapeA.neg.ts'), 'export const broken: number = "x"\n')
  const res = await cmdGate(root)
  expect(res.invariants.map((i) => i.id)).toEqual(['shapeA', 'd1', 'shapeB'])
  expect(res.invariants.find((i) => i.id === 'shapeA')?.pass).toBe(false)
  expect(res.invariants.find((i) => i.id === 'shapeB')?.pass).toBe(true)
  expect(res.invariants.find((i) => i.id === 'd1')?.pass).toBe(true)
})

// ---------- validateReport ----------

test('validateReport names the exact missing path', () => {
  expect(() => validateReport({ run: { id: 'R', mode: 'build' } })).toThrow(/run\.spec/)
})

test('validateReport rejects a bad mode and a bad gate', () => {
  expect(() => validateReport(report({ run: { mode: 'nope' as never } }))).toThrow(/run\.mode/)
  expect(() => validateReport(report({ run: { gate: 'maybe' as never } }))).toThrow(/run\.gate/)
})

// ---------- AC6: persist (build done / model parked / triage gate / dedup) ----------

test('AC6: persist marks a build item done on a green gate', () => {
  const root = tmpRepo()
  cmdInit(root)
  patchState(root, (s) => {
    s.roadmap = [{ id: 'I1', title: 't', slicePaths: [], status: 'pending' }]
  })
  const res = cmdPersist(root, report({ run: { id: 'R1', mode: 'build' }, itemId: 'I1' }))
  expect(res.item?.status).toBe('done')
  expect(loadState(root).roadmap[0]!.status).toBe('done')
})

test('AC6/AC8: persist parks a model-change proposal and blocks the item (never auto-applies)', () => {
  const root = tmpRepo()
  cmdInit(root)
  patchState(root, (s) => {
    s.roadmap = [{ id: 'I1', title: 't', slicePaths: [], status: 'pending' }]
  })
  const res = cmdPersist(
    root,
    report({
      run: { id: 'R1', mode: 'build', gate: 'failed' },
      itemId: 'I1',
      modelChange: { proposedBy: 'planner', reason: 'need a new distinction', diff: '+ INV-new' },
    }),
  )
  expect(res.modelChangeParked).toBe(true)
  const st = loadState(root)
  expect(st.roadmap[0]!.status).toBe('blocked')
  expect(st.pendingModelChange?.reason).toContain('new distinction')
})

test('AC6: persist REFUSES when an open risk has no disposition', () => {
  const root = tmpRepo()
  cmdInit(root)
  patchState(root, (s) => {
    s.risks = [{ id: 'RK1', desc: 'd', owner: 'o', severity: 'high', originRun: 'R0', status: 'open', history: [] }]
  })
  expect(() => cmdPersist(root, report({ run: { id: 'R1' } }))).toThrow(/undispositioned/)
})

test('AC6: persist closes an open risk when the report disposes it, and records history', () => {
  const root = tmpRepo()
  cmdInit(root)
  patchState(root, (s) => {
    s.risks = [{ id: 'RK1', desc: 'd', owner: 'o', severity: 'low', originRun: 'R0', status: 'open', history: [] }]
  })
  const res = cmdPersist(
    root,
    report({ run: { id: 'R1' }, risks: { new: [], dispositions: [{ riskId: 'RK1', action: 'close', reason: 'fixed' }] } }),
  )
  expect(res.risksClosed).toContain('RK1')
  const st = loadState(root)
  expect(st.risks[0]!.status).toBe('closed')
  expect(st.risks[0]!.history[0]!.action).toBe('close')
})

test('AC6: persist rejects a duplicate run id', () => {
  const root = tmpRepo()
  cmdInit(root)
  cmdPersist(root, report({ run: { id: 'R1' } }))
  expect(() => cmdPersist(root, report({ run: { id: 'R1' } }))).toThrow(/duplicate run id/)
})

test('AC6: persist rejects a duplicate risk id', () => {
  const root = tmpRepo()
  cmdInit(root)
  patchState(root, (s) => {
    s.risks = [{ id: 'RK1', desc: 'd', owner: 'o', severity: 'low', originRun: 'R0', status: 'closed', history: [] }]
  })
  expect(() =>
    cmdPersist(root, report({ run: { id: 'R1' }, risks: { new: [{ id: 'RK1', desc: 'again', owner: 'o', severity: 'low' }], dispositions: [] } })),
  ).toThrow(/duplicate risk id/)
})

test('AC6: persist appends a run line and one bounce line per bounce', () => {
  const root = tmpRepo()
  cmdInit(root)
  const res = cmdPersist(
    root,
    report({
      run: { id: 'R1', gate: 'residual' },
      slices: [{ id: 'S1', class: 'logic', owner: 'o', verdict: 'bounce', bounces: [{ ac: 'AC1', reason: 'off-by-one' }] }],
    }),
  )
  expect(res.bounces).toBe(1)
  const ledger = readFileSync(paths(root).ledger, 'utf8')
  const lines = ledger.trim().split('\n').map((l) => JSON.parse(l))
  expect(lines.filter((l) => l.type === 'run').length).toBe(1)
  expect(lines.filter((l) => l.type === 'bounce').length).toBe(1)
  expect(lines.find((l) => l.type === 'bounce').reason).toBe('off-by-one')
})

test('AC6: persist advances grounding and partition stamps', () => {
  const root = tmpRepo()
  cmdInit(root)
  const res = cmdPersist(
    root,
    report({
      run: { id: 'R1' },
      stamps: {
        grounding: { commit: 'abc123', watch: ['src/'] },
        partition: { commit: 'abc123', slices: [{ id: 'P1', class: 'logic', paths: ['src/'] }] },
      },
    }),
  )
  expect(res.stampsAdvanced).toContain('grounding')
  expect(res.stampsAdvanced).toContain('partition')
  const st = loadState(root)
  expect(st.grounding.commit).toBe('abc123')
  expect(st.partition.slices[0]!.id).toBe('P1')
})

test('AC6: re-persisting after a crash before the ledger append is idempotent', () => {
  const root = tmpRepo()
  cmdInit(root)
  const rep = report({ run: { id: 'R1' }, decisions: [{ id: 'D1', title: 't', body: 'b' }] })
  cmdPersist(root, rep)
  // Simulate a crash AFTER state + prose were written but BEFORE the ledger run-line landed:
  // the ledger is the commit marker, so wipe it and re-run the exact same report.
  writeFileSync(paths(root).ledger, '')
  cmdPersist(root, rep)
  const st = loadState(root)
  expect(st.decisions).toEqual(['D1'])
  const decisions = readFileSync(paths(root).decisions, 'utf8')
  expect(decisions.split('\n## D1: ').length).toBe(2) // exactly one occurrence
  const runLines = readFileSync(paths(root).ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type === 'run')
  expect(runLines.length).toBe(1)
})

// ---------- AC5: triage ----------

test('AC5: triage records a disposition and requires a reason', () => {
  const root = tmpRepo()
  cmdInit(root)
  patchState(root, (s) => {
    s.risks = [{ id: 'RK1', desc: 'd', owner: 'o', severity: 'low', originRun: 'R0', status: 'open', history: [] }]
  })
  expect(() => cmdTriage(root, 'RK1', 'close', '')).toThrow(/reason/)
  const res = cmdTriage(root, 'RK1', 'defer', 'next sprint')
  expect(res.pending[0]!.action).toBe('defer')
  expect(() => cmdTriage(root, 'NOPE', 'close', 'x')).toThrow(/unknown risk/)
})

test('AC5/AC6: a pending triage disposition satisfies the persist gate', () => {
  const root = tmpRepo()
  cmdInit(root)
  patchState(root, (s) => {
    s.risks = [{ id: 'RK1', desc: 'd', owner: 'o', severity: 'low', originRun: 'R0', status: 'open', history: [] }]
  })
  cmdTriage(root, 'RK1', 'defer', 'later')
  const res = cmdPersist(root, report({ run: { id: 'R1' } }))
  expect(res.risksDeferred).toContain('RK1')
  expect(loadState(root).pendingTriage.length).toBe(0)
})

// ---------- AC7: evidence-derived ratchet ----------

test('AC7: a class becomes eligible only after consecutive clean runs, and grant needs an approver', () => {
  const root = tmpRepo()
  cmdInit(root)
  cmdPersist(root, report({ run: { id: 'R1' } }))
  cmdPersist(root, report({ run: { id: 'R2' } }))
  const afterTwo = cmdRatchet(root, 'logic').classes[0]!
  expect(afterTwo.consecutiveClean).toBe(2)
  expect(afterTwo.eligible).toBe(1)
  expect(() => cmdRatchet(root, 'logic', { grant: 2, approvedBy: 'human' })).toThrow(/not eligible/)
  expect(() => cmdRatchet(root, 'logic', { grant: 1, approvedBy: '' })).toThrow(/approver/)
  const granted = cmdRatchet(root, 'logic', { grant: 1, approvedBy: 'human' }).classes[0]!
  expect(granted.level).toBe(1)
})

test('AC7: a never-ratchet class is never eligible and cannot be granted', () => {
  const root = tmpRepo()
  cmdInit(root)
  for (const id of ['R1', 'R2', 'R3', 'R4']) {
    cmdPersist(root, report({ run: { id }, slices: [{ id: 'S', class: 'seam', owner: 'o', verdict: 'accept', bounces: [] }] }))
  }
  const seam = cmdRatchet(root, 'seam').classes[0]!
  expect(seam.neverRatchet).toBe(true)
  expect(seam.eligible).toBe(0)
  expect(() => cmdRatchet(root, 'seam', { grant: 1, approvedBy: 'human' })).toThrow(/never-ratchet/)
})

test('AC6/AC7: a dirty run demotes a granted class to L0', () => {
  const root = tmpRepo()
  cmdInit(root)
  cmdPersist(root, report({ run: { id: 'R1' } }))
  cmdPersist(root, report({ run: { id: 'R2' } }))
  cmdRatchet(root, 'logic', { grant: 1, approvedBy: 'human' })
  expect(loadState(root).ratchet.grants['logic']!.level).toBe(1)
  const res = cmdPersist(
    root,
    report({
      run: { id: 'R3', gate: 'failed' },
      slices: [{ id: 'S', class: 'logic', owner: 'o', verdict: 'bounce', bounces: [{ ac: 'AC1', reason: 'regressed' }] }],
    }),
  )
  expect(res.demoted).toContain('logic')
  expect(loadState(root).ratchet.grants['logic']!.level).toBe(0)
})

// ---------- AC4: recall (verify-before-trust) ----------

test('AC4: recall reports a no-stamp grounding layer and never throws on a missing model', async () => {
  const { root } = gitRepo()
  cmdInit(root)
  rmSync(paths(root).modelJson) // bootstrap: before P0 there is no model on disk
  const packet = await cmdRecall(root)
  expect(packet.grounding.stale).toBe(true)
  expect(packet.grounding.reason).toBe('no-stamp')
  expect(packet.modelOk).toBe(false) // recall must not throw when the model is absent
  expect(packet.invariantCount).toBe(0)
  expect(packet.runCount).toBe(0)
})

test('AC4: recall flags grounding stale when a watched path changed since the stamp', async () => {
  const { root, c0 } = gitRepo()
  cmdInit(root)
  patchState(root, (s) => {
    s.grounding = { commit: c0, watch: ['src/'] }
  })
  const fresh = await cmdRecall(root)
  expect(fresh.grounding.stale).toBe(false)
  commit(root, 'src/x.ts', 'export const x = 1\n', 'touch src')
  const stale = await cmdRecall(root)
  expect(stale.grounding.stale).toBe(true)
  expect(stale.grounding.reason).toBe('watch-touched')
  expect(stale.grounding.changed).toContain('src/x.ts')
})

test('AC4: recall surfaces nextItem, pendingModelChange, topBounces, and lastRun', async () => {
  const { root } = gitRepo()
  cmdInit(root)
  patchState(root, (s) => {
    s.roadmap = [{ id: 'I1', title: 't', slicePaths: [], status: 'pending' }]
    s.pendingModelChange = { proposedBy: 'p', reason: 'r', diff: 'd' }
  })
  cmdPersist(
    root,
    report({
      run: { id: 'R1', gate: 'residual' },
      slices: [{ id: 'S', class: 'logic', owner: 'o', verdict: 'bounce', bounces: [{ ac: 'AC1', reason: 'flaky' }] }],
    }),
  )
  const packet = await cmdRecall(root)
  expect(packet.nextItem?.id).toBe('I1')
  expect(packet.pendingModelChange?.reason).toBe('r')
  expect(packet.topBounces[0]!.count).toBe(1)
  expect(packet.lastRun?.id).toBe('R1')
  expect(packet.runCount).toBe(1)
})

test('AC4: recall preserves a multi-word bounce reason in topBounces', async () => {
  const { root } = gitRepo()
  cmdInit(root)
  cmdPersist(
    root,
    report({
      run: { id: 'R1', gate: 'residual' },
      slices: [{ id: 'S', class: 'logic', owner: 'o', verdict: 'bounce', bounces: [{ ac: 'AC1', reason: 'off by one in the loop' }] }],
    }),
  )
  const packet = await cmdRecall(root)
  expect(packet.topBounces[0]!.reason).toBe('off by one in the loop')
  expect(packet.topBounces[0]!.class).toBe('logic')
})

test('AC4: topBounces keeps class+reason pairs distinct that would collide under a space-joined key', async () => {
  const { root } = gitRepo()
  cmdInit(root)
  // 'a' + 'b c' and 'a b' + 'c' both flatten to "a b c" under a space-joined key; the tuple key
  // must keep them as two separate bounce buckets.
  cmdPersist(
    root,
    report({
      run: { id: 'R1', gate: 'residual' },
      slices: [
        { id: 'S1', class: 'a', owner: 'o', verdict: 'bounce', bounces: [{ ac: 'AC1', reason: 'b c' }] },
        { id: 'S2', class: 'a b', owner: 'o', verdict: 'bounce', bounces: [{ ac: 'AC2', reason: 'c' }] },
      ],
    }),
  )
  const packet = await cmdRecall(root)
  expect(packet.topBounces.length).toBe(2)
  expect(packet.topBounces.every((b) => b.count === 1)).toBe(true)
  expect(new Set(packet.topBounces.map((b) => b.class))).toEqual(new Set(['a', 'a b']))
})

test('AC4: recall flags only the partition slices whose watched paths changed since the stamp', async () => {
  const { root, c0 } = gitRepo()
  cmdInit(root)
  patchState(root, (s) => {
    s.partition = {
      commit: c0,
      slices: [
        { id: 'P1', class: 'logic', paths: ['src/p'] },
        { id: 'P2', class: 'logic', paths: ['src/q'] },
      ],
    }
  })
  commit(root, 'src/p/x.ts', 'export const x = 1\n', 'touch P1 only')
  const packet = await cmdRecall(root)
  expect(packet.partition.stale).toBe(true)
  expect(packet.partition.reason).toBe('watch-touched')
  expect(packet.partition.staleSlices.map((s) => s.id)).toEqual(['P1'])
  expect(packet.partition.staleSlices[0]!.changed).toContain('src/p/x.ts')
})

test('AC4: staleness matches on a path boundary, not a string prefix', async () => {
  const { root, c0 } = gitRepo()
  cmdInit(root)
  patchState(root, (s) => {
    s.grounding = { commit: c0, watch: ['src/a'] }
  })
  commit(root, 'src/ab.ts', 'export const x = 1\n', 'sibling file, not under src/a')
  const sibling = await cmdRecall(root)
  expect(sibling.grounding.stale).toBe(false) // src/ab.ts must not match the watch entry src/a
  commit(root, 'src/a/x.ts', 'export const y = 1\n', 'inside src/a')
  const inside = await cmdRecall(root)
  expect(inside.grounding.stale).toBe(true)
  expect(inside.grounding.changed).toContain('src/a/x.ts')
})

test('AC4: recall surfaces a seeded open risk in both openRisks and mustTriage', async () => {
  const { root } = gitRepo()
  cmdInit(root)
  patchState(root, (s) => {
    s.risks = [{ id: 'RK1', desc: 'd', owner: 'o', severity: 'high', originRun: 'R0', status: 'open', history: [] }]
  })
  const packet = await cmdRecall(root)
  expect(packet.openRisks.map((r) => r.id)).toEqual(['RK1'])
  expect(packet.mustTriage.map((r) => r.id)).toEqual(['RK1'])
})

// ---------- planTick (the shared fan-out plan) ----------

function recallStub(over: Partial<RecallPacket>): RecallPacket {
  return {
    modelHash: null,
    modelOk: true,
    invariantCount: 0,
    roadmap: [],
    nextItem: null,
    pendingModelChange: null,
    grounding: { commit: null, stale: false, reason: null, changed: [] },
    partition: over.partition ?? { commit: null, stale: false, reason: null, slices: [], staleSlices: [] },
    openRisks: [],
    mustTriage: [],
    pendingTriage: [],
    decisions: { file: '.vader/DECISIONS.md', count: 0 },
    conventions: { file: '.vader/CONVENTIONS.md' },
    topBounces: over.topBounces ?? [],
    ratchet: over.ratchet ?? [],
    lastRun: null,
    runCount: 0,
  }
}

test('planTick routes a seam slice to seamFirst with the full voter panel', () => {
  const plan = planTick(
    recallStub({
      partition: { commit: null, stale: false, reason: null, slices: [{ id: 'S0', class: 'seam', paths: ['src/seam'] }], staleSlices: [] },
      ratchet: [{ class: 'seam', level: 0, eligible: 0, consecutiveClean: 0, neverRatchet: true }],
    }),
  )
  expect(plan.seamFirst).toEqual([{ id: 'S0', class: 'seam', voters: 3, reason: 'seam', touched: false }])
  expect(plan.siblings).toEqual([])
})

test('planTick scales voters for never-ratchet and previously-bounced classes, else one', () => {
  const plan = planTick(
    recallStub({
      partition: {
        commit: null,
        stale: false,
        reason: null,
        slices: [
          { id: 'S1', class: 'security', paths: ['a'] },
          { id: 'S2', class: 'logic', paths: ['b'] },
          { id: 'S3', class: 'plumbing', paths: ['c'] },
        ],
        staleSlices: [],
      },
      ratchet: [{ class: 'security', level: 0, eligible: 0, consecutiveClean: 0, neverRatchet: true }],
      topBounces: [{ class: 'logic', reason: 'off by one', count: 2 }],
    }),
  )
  expect(plan.seamFirst).toEqual([])
  expect(plan.siblings).toEqual([
    { id: 'S1', class: 'security', voters: 3, reason: 'never-ratchet', touched: false },
    { id: 'S2', class: 'logic', voters: 3, reason: 'top-bounce', touched: false },
    { id: 'S3', class: 'plumbing', voters: 1, reason: 'default', touched: false },
  ])
})

test('planTick marks only the stale partition slices touched and never drops an untouched one', () => {
  const plan = planTick(
    recallStub({
      partition: {
        commit: 'c0',
        stale: true,
        reason: 'watch-touched',
        slices: [
          { id: 'S1', class: 'logic', paths: ['a'] },
          { id: 'S2', class: 'logic', paths: ['b'] },
        ],
        staleSlices: [{ id: 'S2', changed: ['b/x.ts'] }],
      },
    }),
  )
  // both slices are still planned (never dropped); only the changed one is touched.
  expect(plan.siblings).toEqual([
    { id: 'S1', class: 'logic', voters: 1, reason: 'default', touched: false },
    { id: 'S2', class: 'logic', voters: 1, reason: 'default', touched: true },
  ])
})

test('planTick treats every slice as touched when the partition has no usable stamp', () => {
  for (const reason of ['no-stamp', 'missing-commit'] as const) {
    const plan = planTick(
      recallStub({
        partition: {
          commit: reason === 'no-stamp' ? null : 'gone',
          stale: true,
          reason,
          slices: [{ id: 'S1', class: 'logic', paths: ['a'] }],
          staleSlices: [],
        },
      }),
    )
    // cannot compute per-slice staleness, so verify all rather than skip any.
    expect(plan.siblings[0]!.touched).toBe(true)
  }
})

// ---------- AC1-AC7: CLI binary smoke ----------

test('vader binary: init then gate on empty model exits 0', () => {
  const root = tmpRepo()
  const bin = join(import.meta.dir, 'vader.ts')
  execFileSync('bun', [bin, 'init', '--root', root], { encoding: 'utf8' })
  writeFileSync(join(root, '.vader', 'gate.json'), JSON.stringify({ repoCheck: ['true'] }))
  const out = execFileSync('bun', [bin, 'gate', '--root', root], { encoding: 'utf8' })
  expect(JSON.parse(out).pass).toBe(true)
})

test('vader binary: persist from a file, then recall and ratchet over the CLI', () => {
  const { root } = gitRepo()
  const bin = join(import.meta.dir, 'vader.ts')
  execFileSync('bun', [bin, 'init', '--root', root], { encoding: 'utf8' })
  const rep = report({ run: { id: 'R1' } })
  const repPath = join(root, 'run.json')
  writeFileSync(repPath, JSON.stringify(rep))
  const persisted = JSON.parse(execFileSync('bun', [bin, 'persist', repPath, '--root', root], { encoding: 'utf8' }))
  expect(persisted.run).toBe('R1')
  const recalled = JSON.parse(execFileSync('bun', [bin, 'recall', '--root', root], { encoding: 'utf8' }))
  expect(recalled.runCount).toBe(1)
  const ratchet = JSON.parse(execFileSync('bun', [bin, 'ratchet', 'logic', '--root', root], { encoding: 'utf8' }))
  expect(ratchet.classes[0].consecutiveClean).toBe(1)
})

test('vader binary: persist refuses an undispositioned risk and exits nonzero', () => {
  const root = tmpRepo()
  const bin = join(import.meta.dir, 'vader.ts')
  execFileSync('bun', [bin, 'init', '--root', root], { encoding: 'utf8' })
  patchState(root, (s) => {
    s.risks = [{ id: 'RK1', desc: 'd', owner: 'o', severity: 'high', originRun: 'R0', status: 'open', history: [] }]
  })
  const repPath = join(root, 'run.json')
  writeFileSync(repPath, JSON.stringify(report({ run: { id: 'R1' } })))
  let code = 0
  try {
    execFileSync('bun', [bin, 'persist', repPath, '--root', root], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    code = (e as { status?: number }).status ?? 1
  }
  expect(code).toBe(1)
})
