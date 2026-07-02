import { spawn } from 'node:child_process'
import type { LaunchSpec } from './index.js'
import { psCommand } from './index.js'

// 单个服务的 spawn 参数：在自己的 detached 控制台窗口里用 PowerShell 跑命令。
export function buildWinSpawn(spec: LaunchSpec, psHost: string): {
  file: string; args: string[]
  opts: { cwd: string; detached: true; stdio: 'ignore'; windowsHide: false; env?: NodeJS.ProcessEnv }
} {
  return {
    file: psHost,
    args: ['-NoExit', '-Command', psCommand(spec)],
    opts: {
      cwd: spec.cwd, detached: true, stdio: 'ignore', windowsHide: false,
      env: spec.env ? { ...process.env, ...spec.env } : undefined,
    },
  }
}

export async function runWin(
  specs: LaunchSpec[], psHost: 'pwsh' | 'powershell',
): Promise<{ pids: (number | undefined)[] }> {
  const pids = specs.map(s => {
    const { file, args, opts } = buildWinSpawn(s, psHost)
    const child = spawn(file, args, opts)
    child.unref()
    return child.pid
  })
  return { pids }
}
