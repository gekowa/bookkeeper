import type { LaunchSpec } from './index.js'
import { posixLine } from './index.js'

export function renderPrint(specs: LaunchSpec[]): string {
  return specs.map(s => `# ${s.name}  (cwd: ${s.cwd})\n${posixLine(s)}`).join('\n\n')
}
