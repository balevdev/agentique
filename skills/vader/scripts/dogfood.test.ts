import { test, expect } from 'bun:test'
import { cmdInit, cmdGen, cmdGate, paths } from './vader.ts'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The executable proof of the thesis: a collapsed architectural boundary becomes
// a deterministic gate failure keyed by invariant id, in a fresh repo, no judgment.
test('dogfood: a collapsed boundary becomes a deterministic gate failure by id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vader-df-'))
  cmdInit(root)
  writeFileSync(paths(root).gate, JSON.stringify({ repoCheck: ['true'] }))
  writeFileSync(
    paths(root).modelJson,
    JSON.stringify({
      concepts: {},
      invariants: [
        {
          id: 'INV-boundary',
          kind: 'dependency',
          statement: 'common must not import etl',
          check: { forbidImport: { from: 'common/**', to: 'etl/**' } },
        },
      ],
    }),
  )
  await cmdGen(root)
  expect((await cmdGate(root)).pass).toBe(true)

  mkdirSync(join(root, 'common'), { recursive: true })
  writeFileSync(join(root, 'common', 'svc.ts'), "import { x } from 'etl/stage'\n")
  const after = await cmdGate(root)
  expect(after.pass).toBe(false)
  expect(after.invariants.find((i) => i.id === 'INV-boundary')?.pass).toBe(false)
})
