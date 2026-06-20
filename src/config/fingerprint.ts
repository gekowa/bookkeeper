import { createHash } from 'node:crypto'
import type { ProjectConfig } from '../core/types.js'

export function fingerprint(config: ProjectConfig): string {
  const stable = JSON.stringify(config, Object.keys(config).sort())
  return 'sha256:' + createHash('sha256').update(stable).digest('hex')
}
