import type { StateFile } from '../state/schema.js'

export function findSetByWorktree(state: StateFile, worktreeDir: string): string | null {
  for (const [n, r] of Object.entries(state.sets))
    if (r.owner?.worktree === worktreeDir) return n
  return null
}

export function deallocateInState(state: StateFile, n: string): void {
  const r = state.sets[n]; if (!r) return
  r.status = 'free'; r.owner = null
}
