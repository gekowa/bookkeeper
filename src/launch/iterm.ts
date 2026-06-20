import { execa } from 'execa'
import type { LaunchSpec } from './index.js'

export async function runIterm(specs: LaunchSpec[]): Promise<void> {
  // 用 osascript 在新窗口逐个垂直分割运行命令
  const lines: string[] = ['tell application "iTerm2"', 'create window with default profile', 'tell current session of current window']
  specs.forEach((s, i) => {
    if (i > 0) lines.push('set newSession to (split vertically with default profile)', 'tell newSession')
    lines.push(`write text "cd ${s.cwd.replace(/"/g, '\\"')} && ${s.command.replace(/"/g, '\\"')}"`)
    if (i > 0) lines.push('end tell')
  })
  lines.push('end tell', 'end tell')
  await execa('osascript', lines.flatMap(l => ['-e', l]))
}
