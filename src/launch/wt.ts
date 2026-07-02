import { execa } from 'execa'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LaunchSpec } from './index.js'
import { psPaneCommand } from './index.js'

const PID_DIR = join(tmpdir(), 'bk-run')

// 用 cwd + name 唯一定位 pidfile（每个 worktree 的 cwd 互不相同）。
export function pidFileFor(spec: LaunchSpec): string {
  const key = `${spec.cwd}__${spec.name}`.replace(/[^A-Za-z0-9]+/g, '_')
  return join(PID_DIR, `${key}.pid`)
}

// pane 命令：PowerShell 先把自身 $PID 写进 pidfile，再跑原命令。
function paneScript(command: string, pidFile: string): string {
  // 注：$PID 为 PowerShell HOST 进程的 PID，服务作为其子进程运行，bk stop 须用 taskkill /T 才能树杀到子进程。
  return `$PID | Out-File -Encoding ascii '${pidFile}'; ${command}`
}

// 构建 `wt` 的 argv：new-tab + 重复 split-pane（auto 平铺），子命令以 ';' 分隔。
export function buildWtArgs(specs: LaunchSpec[], psHost: string, pidFiles: string[]): string[] {
  const args: string[] = []
  specs.forEach((s, i) => {
    if (i > 0) args.push(';', 'split-pane')
    else args.push('new-tab')
    args.push('-d', s.cwd, psHost, '-NoExit', '-Command', paneScript(psPaneCommand(s), pidFiles[i]))
  })
  return args
}

// 轮询读取 pidfile（最多约 3s），拿不到返回 undefined。
async function readPid(pidFile: string): Promise<number | undefined> {
  for (let i = 0; i < 30; i++) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (!Number.isNaN(pid)) return pid
    } catch { /* 还没写出来 */ }
    await new Promise(r => setTimeout(r, 100))
  }
  return undefined
}

export async function runWt(
  specs: LaunchSpec[], psHost: 'pwsh' | 'powershell',
): Promise<{ pids: (number | undefined)[] }> {
  if (!specs.length) return { pids: [] }
  const pidFiles = specs.map(pidFileFor)
  mkdirSync(dirname(pidFiles[0]), { recursive: true })
  for (const f of pidFiles) { try { rmSync(f) } catch { /* 无旧文件 */ } }
  await execa('wt', buildWtArgs(specs, psHost, pidFiles))
  const pids = await Promise.all(pidFiles.map(readPid))
  return { pids }
}
