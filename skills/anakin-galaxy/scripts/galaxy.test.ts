import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  cmdInit,
  cmdRecall,
  cmdTriage,
  cmdPersist,
  cmdRatchet,
  loadState,
  validateReport,
  GalaxyError,
  type RunReport,
} from './galaxy'

let root = ''

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function initRepo(): void {
  git('init', '-q')
  git('config', 'user.email', 'test@galaxy.local')
  git('config', 'user.name', 'galaxy-test')
  writeFileSync(join(root, 'README.md'), 'seed\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
}

function commitFile(path: string, content: string, msg: string): string {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
  git('add', '-A')
  git('commit', '-q', '-m', msg)
  return git('rev-parse', 'HEAD')
}

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    run: { id: 'r1', mode: 'build', spec: 'test spec', commitRange: 'a..b', gate: 'green' },
    slices: [{ id: 'S1', class: 'api', owner: 'o1', verdict: 'accept', bounces: [] }],
    risks: { new: [], dispositions: [] },
    decisions: [],
    conventions: [],
    ...overrides,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'galaxy-test-'))
  initRepo()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('init', () => {
  test('creates the full .galaxy layout', () => {
    const res = cmdInit(root)
    expect(res.alreadyInitialized).toBe(false)
    for (const f of ['state.json', 'LEDGER.jsonl', 'GROUNDING.md', 'DECISIONS.md', 'CONVENTIONS.md']) {
      expect(existsSync(join(root, '.galaxy', f))).toBe(true)
    }
    expect(existsSync(join(root, '.galaxy', 'runs'))).toBe(true)
  })

  test('is idempotent and does not clobber existing state', () => {
    cmdInit(root)
    cmdPersist(root, report())
    const res = cmdInit(root)
    expect(res.alreadyInitialized).toBe(true)
    const recall = cmdRecall(root)
    expect(recall.runCount).toBe(1)
  })
})

describe('validateReport', () => {
  test('accepts a well-formed report', () => {
    expect(() => validateReport(report())).not.toThrow()
  })

  test('rejects missing run id with a named path', () => {
    const bad = report() as unknown as { run: Record<string, unknown> }
    delete bad.run.id
    expect(() => validateReport(bad)).toThrow(/run\.id/)
  })

  test('rejects a bad gate value', () => {
    const bad = report({ run: { id: 'r1', mode: 'build', spec: 's', commitRange: 'a..b', gate: 'maybe' as never } })
    expect(() => validateReport(bad)).toThrow(/run\.gate/)
  })

  test('rejects a slice missing class', () => {
    const bad = report() as unknown as { slices: Record<string, unknown>[] }
    delete bad.slices[0]?.class
    expect(() => validateReport(bad)).toThrow(/slices\[0\]\.class/)
  })

  test('rejects non-object input', () => {
    expect(() => validateReport(null)).toThrow(GalaxyError)
    expect(() => validateReport('hi')).toThrow(GalaxyError)
  })
})

describe('persist', () => {
  beforeEach(() => cmdInit(root))

  test('appends a run line and returns a summary', () => {
    const res = cmdPersist(root, report())
    expect(res.run).toBe('r1')
    const ledger = readFileSync(join(root, '.galaxy', 'LEDGER.jsonl'), 'utf8').trim().split('\n')
    expect(ledger.length).toBe(1)
    const line = JSON.parse(ledger[0] ?? '')
    expect(line.type).toBe('run')
    expect(line.id).toBe('r1')
  })

  test('rejects a duplicate run id', () => {
    cmdPersist(root, report())
    expect(() => cmdPersist(root, report())).toThrow(/duplicate run id/)
  })

  test('appends one bounce line per bounce', () => {
    cmdPersist(root, report({
      slices: [{ id: 'S1', class: 'api', owner: 'o1', verdict: 'bounce', bounces: [
        { ac: 'AC1', reason: 'hollow test' },
        { ac: 'AC2', reason: 'no code' },
      ] }],
    }))
    const lines = readFileSync(join(root, '.galaxy', 'LEDGER.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.filter((l) => l.type === 'bounce').length).toBe(2)
  })

  test('a failed validation leaves state and ledger untouched', () => {
    cmdPersist(root, report())
    const stateBefore = readFileSync(join(root, '.galaxy', 'state.json'), 'utf8')
    const ledgerBefore = readFileSync(join(root, '.galaxy', 'LEDGER.jsonl'), 'utf8')
    expect(() => cmdPersist(root, { nonsense: true } as unknown as RunReport)).toThrow(GalaxyError)
    expect(readFileSync(join(root, '.galaxy', 'state.json'), 'utf8')).toBe(stateBefore)
    expect(readFileSync(join(root, '.galaxy', 'LEDGER.jsonl'), 'utf8')).toBe(ledgerBefore)
  })

  test('records new risks as open', () => {
    cmdPersist(root, report({
      risks: { new: [{ id: 'R1', desc: 'flaky suite', owner: 'me', severity: 'medium' }], dispositions: [] },
    }))
    const recall = cmdRecall(root)
    expect(recall.mustTriage.map((r) => r.id)).toEqual(['R1'])
  })

  test('rejects a duplicate risk id', () => {
    cmdPersist(root, report({
      risks: { new: [{ id: 'R1', desc: 'a', owner: 'me', severity: 'low' }], dispositions: [] },
    }))
    expect(() => cmdPersist(root, report({
      run: { id: 'r2', mode: 'build', spec: 's', commitRange: 'a..b', gate: 'green' },
      risks: { new: [{ id: 'R1', desc: 'b', owner: 'me', severity: 'low' }], dispositions: [{ riskId: 'R1', action: 'defer', reason: 'later' }] },
    }))).toThrow(/duplicate risk id/)
  })
})

describe('the triage gate', () => {
  beforeEach(() => {
    cmdInit(root)
    cmdPersist(root, report({
      risks: { new: [{ id: 'R1', desc: 'open risk', owner: 'me', severity: 'high' }], dispositions: [] },
    }))
  })

  test('persist refuses while an open risk has no disposition', () => {
    expect(() => cmdPersist(root, report({ run: { id: 'r2', mode: 'build', spec: 's', commitRange: 'a..b', gate: 'green' } })))
      .toThrow(/undispositioned open risks: R1/)
  })

  test('a report disposition unblocks persist', () => {
    const res = cmdPersist(root, report({
      run: { id: 'r2', mode: 'build', spec: 's', commitRange: 'a..b', gate: 'green' },
      risks: { new: [], dispositions: [{ riskId: 'R1', action: 'close', reason: 'fixed in r2' }] },
    }))
    expect(res.risksClosed).toEqual(['R1'])
    expect(cmdRecall(root).mustTriage).toEqual([])
  })

  test('a pending triage from the triage command unblocks persist', () => {
    cmdTriage(root, 'R1', 'defer', 'blocked on infra work')
    const res = cmdPersist(root, report({ run: { id: 'r2', mode: 'build', spec: 's', commitRange: 'a..b', gate: 'green' } }))
    expect(res.risksDeferred).toEqual(['R1'])
    const recall = cmdRecall(root)
    expect(recall.mustTriage.map((r) => r.id)).toEqual(['R1']) // defer keeps it open
    expect(recall.pendingTriage).toEqual([]) // pendings consumed
  })

  test('finding closes the risk (it became contract scope)', () => {
    cmdTriage(root, 'R1', 'finding', 'promoted to contract S2 AC3')
    cmdPersist(root, report({ run: { id: 'r2', mode: 'build', spec: 's', commitRange: 'a..b', gate: 'green' } }))
    expect(cmdRecall(root).mustTriage).toEqual([])
  })

  test('triage rejects an unknown risk id', () => {
    expect(() => cmdTriage(root, 'NOPE', 'close', 'x')).toThrow(/unknown risk/)
  })

  test('disposition history is recorded on the risk', () => {
    cmdTriage(root, 'R1', 'defer', 'first defer')
    cmdPersist(root, report({ run: { id: 'r2', mode: 'build', spec: 's', commitRange: 'a..b', gate: 'green' } }))
    const state = loadState(root)
    const r1 = state.risks.find((r) => r.id === 'R1')
    expect(r1?.history).toEqual([{ run: 'r2', action: 'defer', reason: 'first defer' }])
  })
})

describe('stamps and staleness', () => {
  beforeEach(() => cmdInit(root))

  test('no stamp reports stale with reason no-stamp', () => {
    const recall = cmdRecall(root)
    expect(recall.grounding.stale).toBe(true)
    expect(recall.grounding.reason).toBe('no-stamp')
  })

  test('persist advances a stamp only when the report carries it', () => {
    const head = git('rev-parse', 'HEAD')
    cmdPersist(root, report({ stamps: { grounding: { commit: head, watch: ['src/'] } } }))
    expect(cmdRecall(root).grounding.stale).toBe(false)
    // next persist without stamps must not touch it
    cmdPersist(root, report({ run: { id: 'r2', mode: 'build', spec: 's', commitRange: 'a..b', gate: 'green' } }))
    expect(loadState(root).grounding.commit).toBe(head)
  })

  test('a change inside a watch path marks grounding stale and names the file', () => {
    const head = git('rev-parse', 'HEAD')
    cmdPersist(root, report({ stamps: { grounding: { commit: head, watch: ['src/'] } } }))
    commitFile('src-other.txt', 'x', 'outside watch')
    expect(cmdRecall(root).grounding.stale).toBe(false)
    commitFile('src/core.ts', 'x', 'inside watch')
    const recall = cmdRecall(root)
    expect(recall.grounding.stale).toBe(true)
    expect(recall.grounding.reason).toBe('watch-touched')
    expect(recall.grounding.changed).toEqual(['src/core.ts'])
  })

  test('a vanished stamp commit reports missing-commit, never throws', () => {
    cmdPersist(root, report({ stamps: { grounding: { commit: 'f'.repeat(40), watch: ['src/'] } } }))
    const recall = cmdRecall(root)
    expect(recall.grounding.stale).toBe(true)
    expect(recall.grounding.reason).toBe('missing-commit')
  })

  test('partition staleness is computed per slice', () => {
    const head = git('rev-parse', 'HEAD')
    cmdPersist(root, report({
      stamps: { partition: { commit: head, slices: [
        { id: 'S1', class: 'api', paths: ['api/'] },
        { id: 'S2', class: 'ui', paths: ['web/'] },
      ] } },
    }))
    commitFile('api/route.ts', 'x', 'touch api')
    const recall = cmdRecall(root)
    expect(recall.partition.stale).toBe(true)
    expect(recall.partition.staleSlices).toEqual([{ id: 'S1', changed: ['api/route.ts'] }])
  })
})

describe('ratchet', () => {
  beforeEach(() => cmdInit(root))

  function cleanRun(id: string, cls = 'api'): RunReport {
    return report({
      run: { id, mode: 'build', spec: 's', commitRange: 'a..b', gate: 'green' },
      slices: [{ id: `S-${id}`, class: cls, owner: 'o', verdict: 'accept', bounces: [] }],
    })
  }

  test('a fresh class holds at L0 with no evidence', () => {
    cmdPersist(root, cleanRun('r1'))
    const res = cmdRatchet(root, 'api')
    expect(res.classes[0]?.level).toBe(0)
    expect(res.classes[0]?.eligible).toBe(0)
  })

  test('two consecutive clean runs make L1 eligible, three make L2', () => {
    cmdPersist(root, cleanRun('r1'))
    cmdPersist(root, cleanRun('r2'))
    expect(cmdRatchet(root, 'api').classes[0]?.eligible).toBe(1)
    cmdPersist(root, cleanRun('r3'))
    const res = cmdRatchet(root, 'api').classes[0]
    expect(res?.eligible).toBe(2)
    expect(res?.consecutiveClean).toBe(3)
  })

  test('a bounce resets the streak and demotes a granted class', () => {
    cmdPersist(root, cleanRun('r1'))
    cmdPersist(root, cleanRun('r2'))
    cmdRatchet(root, 'api', { grant: 1, approvedBy: 'boyan' })
    expect(cmdRatchet(root, 'api').classes[0]?.level).toBe(1)
    cmdPersist(root, report({
      run: { id: 'r3', mode: 'build', spec: 's', commitRange: 'a..b', gate: 'green' },
      slices: [{ id: 'S3', class: 'api', owner: 'o', verdict: 'bounce', bounces: [{ ac: 'AC1', reason: 'hollow' }] }],
    }))
    const res = cmdRatchet(root, 'api').classes[0]
    expect(res?.level).toBe(0) // auto-demoted at persist
    expect(res?.consecutiveClean).toBe(0)
  })

  test('a non-green gate breaks the streak for every class in the run', () => {
    cmdPersist(root, cleanRun('r1'))
    cmdPersist(root, report({
      run: { id: 'r2', mode: 'build', spec: 's', commitRange: 'a..b', gate: 'residual' },
      slices: [{ id: 'S2', class: 'api', owner: 'o', verdict: 'accept', bounces: [] }],
    }))
    expect(cmdRatchet(root, 'api').classes[0]?.consecutiveClean).toBe(0)
  })

  test('runs not touching the class neither count nor break the streak', () => {
    cmdPersist(root, cleanRun('r1'))
    cmdPersist(root, cleanRun('r2', 'ui'))
    cmdPersist(root, cleanRun('r3'))
    expect(cmdRatchet(root, 'api').classes[0]?.consecutiveClean).toBe(2)
  })

  test('never-ratchet classes are never eligible regardless of evidence', () => {
    for (const id of ['r1', 'r2', 'r3', 'r4']) cmdPersist(root, cleanRun(id, 'seam'))
    const res = cmdRatchet(root, 'seam').classes[0]
    expect(res?.eligible).toBe(0)
    expect(res?.neverRatchet).toBe(true)
  })

  test('grant refuses a level above eligibility and refuses never-ratchet classes', () => {
    cmdPersist(root, cleanRun('r1'))
    expect(() => cmdRatchet(root, 'api', { grant: 2, approvedBy: 'boyan' })).toThrow(/not eligible/)
    for (const id of ['s1', 's2', 's3']) cmdPersist(root, cleanRun(id, 'seam'))
    expect(() => cmdRatchet(root, 'seam', { grant: 1, approvedBy: 'boyan' })).toThrow(/never-ratchet/)
  })

  test('grant requires an approver', () => {
    cmdPersist(root, cleanRun('r1'))
    cmdPersist(root, cleanRun('r2'))
    expect(() => cmdRatchet(root, 'api', { grant: 1, approvedBy: '' })).toThrow(/approver/)
  })
})

describe('recall', () => {
  beforeEach(() => cmdInit(root))

  test('aggregates top bounce patterns by class and reason', () => {
    cmdPersist(root, report({
      slices: [
        { id: 'S1', class: 'api', owner: 'o', verdict: 'bounce', bounces: [{ ac: 'a', reason: 'hollow test' }] },
        { id: 'S2', class: 'api', owner: 'o', verdict: 'bounce', bounces: [{ ac: 'b', reason: 'hollow test' }] },
        { id: 'S3', class: 'ui', owner: 'o', verdict: 'bounce', bounces: [{ ac: 'c', reason: 'no code' }] },
      ],
    }))
    const recall = cmdRecall(root)
    expect(recall.topBounces[0]).toEqual({ class: 'api', reason: 'hollow test', count: 2 })
    expect(recall.topBounces.length).toBe(2)
  })

  test('reports last run and run count', () => {
    cmdPersist(root, report())
    cmdPersist(root, report({ run: { id: 'r2', mode: 'review', spec: 's2', commitRange: 'a..b', gate: 'residual' } }))
    const recall = cmdRecall(root)
    expect(recall.runCount).toBe(2)
    expect(recall.lastRun?.id).toBe('r2')
    expect(recall.lastRun?.gate).toBe('residual')
  })

  test('throws a clear error when not initialized', () => {
    rmSync(join(root, '.galaxy'), { recursive: true })
    expect(() => cmdRecall(root)).toThrow(/galaxy init/)
  })
})

describe('decisions and conventions', () => {
  beforeEach(() => cmdInit(root))

  test('persist appends decisions and conventions to their files', () => {
    cmdPersist(root, report({
      decisions: [{ id: 'D1', title: 'NATS over Kafka', body: 'Cheaper to operate at our scale.' }],
      conventions: [{ id: 'C1', rule: 'errors via errMessage helper, never inline String(e)' }],
    }))
    const decisions = readFileSync(join(root, '.galaxy', 'DECISIONS.md'), 'utf8')
    const conventions = readFileSync(join(root, '.galaxy', 'CONVENTIONS.md'), 'utf8')
    expect(decisions).toContain('D1')
    expect(decisions).toContain('NATS over Kafka')
    expect(decisions).toContain('run: r1')
    expect(conventions).toContain('errMessage helper')
  })

  test('a superseding decision records what it supersedes', () => {
    cmdPersist(root, report({ decisions: [{ id: 'D1', title: 'A', body: 'a' }] }))
    cmdPersist(root, report({
      run: { id: 'r2', mode: 'build', spec: 's', commitRange: 'a..b', gate: 'green' },
      decisions: [{ id: 'D2', title: 'B', body: 'b', supersedes: 'D1' }],
    }))
    expect(readFileSync(join(root, '.galaxy', 'DECISIONS.md'), 'utf8')).toContain('Supersedes: D1')
  })

  test('persist rejects a supersedes target that was never recorded', () => {
    expect(() => cmdPersist(root, report({ decisions: [{ id: 'D2', title: 'B', body: 'b', supersedes: 'D9' }] })))
      .toThrow(/unknown decision/)
  })
})

describe('CLI surface', () => {
  const cli = join(import.meta.dir, 'galaxy.ts')

  function run(args: string[], expectFail = false): { code: number, stdout: string, stderr: string } {
    const res = Bun.spawnSync(['bun', cli, ...args, '--root', root])
    const out = { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() }
    if (!expectFail && out.code !== 0) throw new Error(`CLI failed: ${out.stderr}`)
    return out
  }

  test('init then recall round-trips as JSON with exit codes', () => {
    expect(run(['init']).code).toBe(0)
    const recall = run(['recall'])
    const packet = JSON.parse(recall.stdout)
    expect(packet.runCount).toBe(0)
    expect(packet.grounding.stale).toBe(true)
  })

  test('persist reads a report file and the triage gate exits non-zero', () => {
    run(['init'])
    const reportPath = join(root, 'report.json')
    writeFileSync(reportPath, JSON.stringify(report({
      risks: { new: [{ id: 'R1', desc: 'd', owner: 'me', severity: 'low' }], dispositions: [] },
    })))
    expect(run(['persist', reportPath]).code).toBe(0)
    writeFileSync(reportPath, JSON.stringify(report({ run: { id: 'r2', mode: 'build', spec: 's', commitRange: 'a..b', gate: 'green' } })))
    const blocked = run(['persist', reportPath], true)
    expect(blocked.code).toBe(1)
    expect(blocked.stderr).toContain('undispositioned open risks: R1')
  })

  test('unknown command exits 1 with usage', () => {
    const res = run(['frobnicate'], true)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('usage')
  })
})
