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
  type RunReport,
  type State,
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
