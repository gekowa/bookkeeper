import { execa } from 'execa'
import type { RunRecord, RunService } from '../core/types.js'

// 容错执行：句柄已失效（session/pane 不存在）时吞错，视为已停。
async function tryExec(file: string, args: string[]): Promise<void> {
  try { await execa(file, args) } catch { /* 已不存在，视为已停 */ }
}

async function closeService(strategy: RunRecord['strategy'], s: RunService): Promise<void> {
  if (strategy === 'iterm' && s.itermSessionId)
    await tryExec('osascript',
      ['-e', `tell application "iTerm2" to tell session id "${s.itermSessionId}" to close`])
  else if (strategy === 'tmux' && s.tmuxPaneId)
    await tryExec('tmux', ['kill-pane', '-t', s.tmuxPaneId])
}

// 停掉 run 中的指定服务（only 缺省 = 全部），返回剩余 run（无剩余则 null）。
export async function stopRun(run: RunRecord, only?: string): Promise<RunRecord | null> {
  const targets = only ? run.services.filter(s => s.name === only) : run.services
  if (run.strategy === 'tmux' && !only && run.tmuxSession) {
    await tryExec('tmux', ['kill-session', '-t', run.tmuxSession])
  } else {
    for (const s of targets) await closeService(run.strategy, s)
  }
  const remaining = run.services.filter(s => !targets.includes(s))
  return remaining.length ? { ...run, services: remaining } : null
}
