import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  VaderError,
  validateConstitution,
  hashModel,
  paths,
  loadState,
  cmdInit,
  cmdGen,
  cmdGate,
  cmdPersist,
  globToRegExp,
} from './vader.ts'

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), 'vader-'))
}

// ---------- Task 2: validation ----------

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
      {
        id: 'INV-dep',
        kind: 'dependency',
        statement: 's',
        check: { forbidImport: { from: 'a/**', to: 'b/**' } },
      },
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

// ---------- Task 3: hash + glob ----------

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
  // toString must be a usable regex literal (forward slash escaped)
  expect(re.toString()).toContain('\\/')
})

// ---------- Task 4: init ----------

test('cmdInit scaffolds .vader and is idempotent', () => {
  const root = tmpRepo()
  const first = cmdInit(root)
  expect(first.created).toContain('.vader/state.json')
  expect(loadState(root).version).toBe(1)
  const second = cmdInit(root)
  expect(second.created).not.toContain('.vader/state.json')
})

test('detectGate falls back to a stub when no toolchain', () => {
  const root = tmpRepo()
  const gate = cmdInit(root).gate
  expect(gate.repoCheck[0]).toBe('echo')
  expect(gate.note).toContain('no toolchain')
})

// ---------- Task 5: router floor (dependency) ----------

test('cmdGen emits a dependency check that fails on a real violation', async () => {
  const root = tmpRepo()
  cmdInit(root)
  const model = {
    concepts: {},
    invariants: [
      {
        id: 'INV-dep',
        kind: 'dependency',
        statement: 'a must not import b',
        check: { forbidImport: { from: 'a/**', to: 'b/**' } },
      },
    ],
  }
  writeFileSync(paths(root).modelJson, JSON.stringify(model))
  const res = await cmdGen(root)
  expect(res.written.some((f) => f.includes('dep-INV-dep'))).toBe(true)
  mkdirSync(join(root, 'a'), { recursive: true })
  writeFileSync(join(root, 'a', 'x.ts'), "import { z } from 'b/y'\n")
  let failed = false
  try {
    execFileSync('bun', [join(paths(root).generated, 'checks', 'dep-INV-dep.ts'), root], {
      encoding: 'utf8',
    })
  } catch {
    failed = true
  }
  expect(failed).toBe(true)
})

test('cmdGen dependency check passes when there is no violation', async () => {
  const root = tmpRepo()
  cmdInit(root)
  const model = {
    concepts: {},
    invariants: [
      {
        id: 'INV-dep',
        kind: 'dependency',
        statement: 'a must not import b',
        check: { forbidImport: { from: 'a/**', to: 'b/**' } },
      },
    ],
  }
  writeFileSync(paths(root).modelJson, JSON.stringify(model))
  await cmdGen(root)
  mkdirSync(join(root, 'a'), { recursive: true })
  writeFileSync(join(root, 'a', 'x.ts'), "import { z } from 'c/ok'\n")
  const out = execFileSync('bun', [join(paths(root).generated, 'checks', 'dep-INV-dep.ts'), root], {
    encoding: 'utf8',
  })
  expect(out).toContain('ok')
})

// ---------- Task 6: TS gold path (shape) ----------

test('cmdGen shape: neg file typechecks, proving the distinction holds', async () => {
  const root = tmpRepo()
  cmdInit(root)
  const model = {
    concepts: {},
    invariants: [
      {
        id: 'pt',
        kind: 'shape',
        statement: 'point is not interval',
        check: { distinct: ['TemporalPoint', 'TemporalInterval'] },
      },
    ],
  }
  writeFileSync(paths(root).modelJson, JSON.stringify(model))
  await cmdGen(root)
  const checks = join(paths(root).generated, 'checks')
  let ok = true
  try {
    execFileSync(
      'bunx',
      ['tsc', '--noEmit', '--strict', '--skipLibCheck', join(checks, 'shape-pt.neg.ts')],
      { encoding: 'utf8' },
    )
  } catch {
    ok = false
  }
  expect(ok).toBe(true)
})

// ---------- Task 7: gate ----------

test('cmdGate fails and names the violated invariant id', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  const model = {
    concepts: {},
    invariants: [
      {
        id: 'INV-dep',
        kind: 'dependency',
        statement: 'a !-> b',
        check: { forbidImport: { from: 'a/**', to: 'b/**' } },
      },
    ],
  }
  writeFileSync(paths(root).modelJson, JSON.stringify(model))
  await cmdGen(root)
  mkdirSync(join(root, 'a'), { recursive: true })
  writeFileSync(join(root, 'a', 'x.ts'), "import { z } from 'b/y'\n")
  const res = await cmdGate(root)
  expect(res.pass).toBe(false)
  expect(res.invariants.find((i) => i.id === 'INV-dep')?.pass).toBe(false)
})

test('cmdGate passes when repoCheck is trivial and the model is empty', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  writeFileSync(paths(root).modelJson, JSON.stringify({ concepts: {}, invariants: [] }))
  const res = await cmdGate(root)
  expect(res.pass).toBe(true)
})

test('cmdGate fails closed when the model hash is unlocked', async () => {
  const root = tmpRepo()
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  writeFileSync(paths(root).modelJson, JSON.stringify({ concepts: {}, invariants: [] }))
  const s = loadState(root)
  s.modelHash = 'deadbeef'
  writeFileSync(paths(root).state, JSON.stringify(s))
  const res = await cmdGate(root)
  expect(res.modelHashLocked).toBe(false)
  expect(res.pass).toBe(false)
})

// ---------- Task 8: persist ----------

test('persist marks an item done on a green gate', () => {
  const root = tmpRepo()
  cmdInit(root)
  const s = loadState(root)
  s.roadmap = [{ id: 'I1', title: 't', slicePaths: [], status: 'pending' }]
  writeFileSync(paths(root).state, JSON.stringify(s))
  cmdPersist(root, {
    itemId: 'I1',
    gate: { pass: true, modelHashLocked: true, repoCheck: null, invariants: [] },
  })
  expect(loadState(root).roadmap[0]!.status).toBe('done')
})

test('persist blocks the item and parks a model-change proposal (never auto-applies)', () => {
  const root = tmpRepo()
  cmdInit(root)
  const s = loadState(root)
  s.roadmap = [{ id: 'I1', title: 't', slicePaths: [], status: 'pending' }]
  writeFileSync(paths(root).state, JSON.stringify(s))
  cmdPersist(root, {
    itemId: 'I1',
    gate: { pass: false, modelHashLocked: true, repoCheck: null, invariants: [] },
    modelChange: { proposedBy: 'planner', reason: 'need a new distinction', diff: '+ INV-new' },
  })
  const st = loadState(root)
  expect(st.roadmap[0]!.status).toBe('blocked')
  expect(st.pendingModelChange?.reason).toContain('new distinction')
})

// ---------- Task 9: CLI binary smoke ----------

test('vader binary: init then gate on empty model exits 0', () => {
  const root = tmpRepo()
  const bin = join(import.meta.dir, 'vader.ts')
  execFileSync('bun', [bin, 'init', '--root', root], { encoding: 'utf8' })
  writeFileSync(join(root, '.vader', 'gate.json'), JSON.stringify({ repoCheck: ['true'] }))
  const out = execFileSync('bun', [bin, 'gate', '--root', root], { encoding: 'utf8' })
  expect(JSON.parse(out).pass).toBe(true)
})
