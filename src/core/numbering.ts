import type { StateFile } from '../state/schema.js'

export function pickNumber(state: StateFile): { n: number; reuse: boolean } {
  const frees = Object.entries(state.sets)
    .filter(([, r]) => r.status === 'free')
    .map(([n]) => Number(n))
    .sort((a, b) => a - b)
  if (frees.length) return { n: frees[0], reuse: true }
  const used = new Set(Object.keys(state.sets).map(Number))
  let n = 1
  while (used.has(n)) n++
  return { n, reuse: false }
}
