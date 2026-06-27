import { execa } from 'execa'
import type { RunRecord } from '../core/types.js'

// 探测当前真实存活的 iTerm session unique id 集合。
// - 先用守卫避免把 iTerm 拉起来（仅探测、不启动）。
// - 解析沿用 iterm.ts 的 ", " 分隔约定；osascript 抛错（如 iTerm 异常）→ 空集。
async function liveItermSessions(): Promise<Set<string>> {
  const lines = [
    'if application "iTerm2" is not running then return {}',
    'tell application "iTerm2"',
    'set out to {}',
    'repeat with w in windows',
    'repeat with t in tabs of w',
    'repeat with s in sessions of t',
    'set out to out & (unique id of s)',
    'end repeat',
    'end repeat',
    'end repeat',
    'return out',
    'end tell',
  ]
  try {
    const { stdout } = await execa('osascript', lines.flatMap(l => ['-e', l]))
    return new Set(stdout.split(', ').map(s => s.trim()).filter(Boolean))
  } catch { return new Set() }
}

// 探测当前真实存活的 tmux pane id 集合；无 server / tmux 缺失等抛错 → 空集。
async function liveTmuxPanes(): Promise<Set<string>> {
  try {
    const { stdout } = await execa('tmux', ['list-panes', '-a', '-F', '#{pane_id}'])
    return new Set(stdout.split('\n').map(s => s.trim()).filter(Boolean))
  } catch { return new Set() }
}

// 用真实进程活性调和 run 记录：剔除句柄已失效（窗口/ pane 已关）的服务。
// 仍有存活 → 返回裁剪后的 run；全部已死 → 返回 null（调用方据此清掉孤儿记录）。
export async function reconcileRun(run: RunRecord): Promise<RunRecord | null> {
  const live = run.strategy === 'iterm' ? await liveItermSessions() : await liveTmuxPanes()
  const alive = run.services.filter(s => {
    const id = run.strategy === 'iterm' ? s.itermSessionId : s.tmuxPaneId
    return id !== undefined && live.has(id)
  })
  return alive.length ? { ...run, services: alive } : null
}
