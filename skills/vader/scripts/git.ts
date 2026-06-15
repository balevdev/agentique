// vader git: the thin layer over `git` the engine needs for staleness. A stamp is a commit;
// a layer is stale when a watched path changed since its stamp. Nothing here reasons about the
// factory model, only about the repo and what moved in it.

import { execFileSync } from 'node:child_process'
import type { Staleness } from './core.ts'

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

export function commitExists(root: string, commit: string): boolean {
  try {
    git(root, ['cat-file', '-e', `${commit}^{commit}`])
    return true
  } catch {
    return false
  }
}

export function changedSince(root: string, commit: string): string[] {
  const out = git(root, ['diff', '--name-only', `${commit}..HEAD`])
  return out === '' ? [] : out.split('\n')
}

// A changed file counts against a watch entry only on a path boundary: 'src/a' must not
// match 'src/ab.ts'. An exact file path matches itself; a directory prefix matches its tree.
export function underWatch(file: string, watch: string[]): boolean {
  return watch.some((w) => file === w || file.startsWith(w.endsWith('/') ? w : `${w}/`))
}

export function staleness(root: string, commit: string | null, watch: string[]): Staleness {
  if (commit === null) return { commit, stale: true, reason: 'no-stamp', changed: [] }
  if (!commitExists(root, commit)) return { commit, stale: true, reason: 'missing-commit', changed: [] }
  const changed = changedSince(root, commit).filter((f) => underWatch(f, watch))
  return changed.length > 0
    ? { commit, stale: true, reason: 'watch-touched', changed }
    : { commit, stale: false, reason: null, changed: [] }
}
