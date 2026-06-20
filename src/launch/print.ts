import type { LaunchSpec } from './index.js'

export function renderPrint(specs: LaunchSpec[]): string {
  return specs.map(s => `# ${s.name}  (cwd: ${s.cwd})\n${s.command}`).join('\n\n')
}
