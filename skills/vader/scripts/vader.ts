// vader: the deterministic engine behind the software factory. Same inputs, same outputs, on
// every host. This file is the CLI front door (init/gen/gate/recall/triage/persist/ratchet) and
// the public barrel: every symbol the skill and tests import is re-exported here, so the module
// split below stays an internal detail. The real work lives in the cohesive modules:
//   core   the data backbone: error, validation primitives, layout, state load/save
//   git    the thin layer over git the engine needs for staleness
//   model  the constitution: types, validate, hash, the gen compiler, enforcement hash
//   gate   the deterministic arbiter: detection, parallel checks, shape-batch, cmdGate
//   memory what the factory remembers: run report, triage, ratchet, persist, recall
//   plan   the single fan-out plan every adapter consumes (planTick)

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { VaderError, paths, loadState, saveState, defaultState } from './core.ts'
import { cmdGen, type Constitution } from './model.ts'
import { detectGate, cmdGate, type GateConfig } from './gate.ts'
import { cmdTriage, cmdPersist, cmdRatchet, cmdRecall } from './memory.ts'

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

// ---------- public barrel ----------
// The skill, the extension, and the tests import from './vader.ts'. Re-export every module so
// the split stays an internal detail and the import surface never changes.
export * from './core.ts'
export * from './git.ts'
export * from './model.ts'
export * from './gate.ts'
export * from './memory.ts'
export * from './plan.ts'

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
