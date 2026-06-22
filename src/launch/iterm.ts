import { execa } from 'execa'
import type { LaunchSpec } from './index.js'
import { planGrid, type GridPlan } from './itermGrid.js'

// 转义反斜杠与双引号，安全嵌入 AppleScript 字符串字面量
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

// 把网格计划渲染成 osascript 逐行脚本：先开窗捕获 s0，再按 steps 分屏，最后按 order 写命令
export function buildItermScript(specs: LaunchSpec[], plan: GridPlan): string[] {
  const lines: string[] = [
    'tell application "iTerm2"',
    'create window with default profile',
    'set s0 to (current session of current window)',
  ]
  for (const step of plan.steps) {
    const verb = step.dir === 'v' ? 'split vertically' : 'split horizontally'
    lines.push(`tell s${step.target}`, `set s${step.next} to (${verb} with default profile)`, 'end tell')
  }
  specs.forEach((s, k) => {
    const sid = plan.order[k] // 第 k 个 service 落在哪个 session
    lines.push(`tell s${sid}`, `write text "cd ${esc(s.cwd)} && ${esc(s.command)}"`, 'end tell')
  })
  lines.push('end tell')
  return lines
}

export async function runIterm(specs: LaunchSpec[]): Promise<void> {
  if (!specs.length) return // 对齐 tmux：无 service 不开窗
  const lines = buildItermScript(specs, planGrid(specs.length))
  await execa('osascript', lines.flatMap(l => ['-e', l]))
}
