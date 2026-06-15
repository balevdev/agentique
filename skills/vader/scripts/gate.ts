// vader gate: the deterministic arbiter. It detects (and validates) the gate config, then runs
// the repo check, fallow when configured, and every compiled invariant check, returning a
// per-invariant pass/fail keyed by id. It fails closed when the model hash or the compiled
// enforcement surface no longer matches its lock. Independent checks run concurrently; the
// verdict is each child's exit code, so parallelism never changes a pass/fail.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { cpus } from 'node:os'
import { paths, loadState, obj, str, arr } from './core.ts'
import { readModel, hashModel, enforcementHash, type Invariant } from './model.ts'

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
  const fallowCheck = gateCfg.fallowCheck
  const [repo, fallow, shapeResults, otherResults] = await Promise.all([
    runCheck(root, gateCfg.repoCheck),
    fallowCheck ? runCheck(root, fallowCheck) : Promise.resolve(null),
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
    fallow: fallow && fallowCheck ? { cmd: fallowCheck.join(' '), pass: fallow.pass } : null,
    invariants,
  }
}
