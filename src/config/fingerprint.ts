import { createHash } from 'node:crypto'
import type { ProjectConfig } from '../core/types.js'

function sortedReplacer(_key: string, value: unknown) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    )
  }
  return value
}

export function fingerprint(config: ProjectConfig): string {
  const stable = JSON.stringify(config, sortedReplacer)
  return 'sha256:' + createHash('sha256').update(stable).digest('hex')
}
