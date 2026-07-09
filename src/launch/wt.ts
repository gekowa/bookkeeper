import { execa } from 'execa'
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LaunchSpec } from './index.js'
import { gridShape } from './grid.js'

const PID_DIR = join(tmpdir(), 'bk-run')

// 用 cwd + name 唯一定位运行时文件（每个 worktree 的 cwd 互不相同）。
function runKeyFor(spec: LaunchSpec): string {
  return `${spec.cwd}__${spec.name}`.replace(/[^A-Za-z0-9]+/g, '_')
}
export function pidFileFor(spec: LaunchSpec): string {
  return join(PID_DIR, `${runKeyFor(spec)}.pid`)
}
export function launcherScriptFor(spec: LaunchSpec): string {
  return join(PID_DIR, `${runKeyFor(spec)}.ps1`)
}

// pane 启动脚本：先把 PowerShell 宿主 $PID 写进 pidfile，再跑服务命令。
// 注：$PID 为宿主进程 PID，服务作为其子进程运行，bk stop 须 taskkill /T 才能树杀到子进程。
// 命令以 -File 落盘执行——wt argv 中不出现用户命令文本，
// 从根上避免 execa→wt→PowerShell 三层引号/元字符（; " & …）转义问题。
// BOM 让 PowerShell 5.1（无 BOM 按 ANSI 解析）正确读 UTF-8；pwsh 不受影响。
export function launcherScriptContent(command: string, pidFile: string): string {
  const escaped = pidFile.replace(/'/g, "''")
  return `\uFEFF$PID | Out-File -Encoding ascii '${escaped}'\n${command}\n`
}

// 构建 wt argv：planGrid 同款均匀网格（列优先），聚焦相对构造。
// 1) new-tab = 格(0,0)；2) 左→右切等宽列（-V）；3) 最右列→左逐列自上而下切行（-H），
// 列间 move-focus left（左邻列此时必为单一整列 pane，方向无歧义）。
// --size 为新 pane 占被切 pane 的比例，依次 (m-1)/m 得到等分。
export function buildWtArgs(specs: LaunchSpec[], psHost: string, scriptFiles: string[]): string[] {
  const counts = gridShape(specs.length)
  const cols = counts.length
  // 列优先下标：第 c 列首格的 service 下标 = 前面各列格数之和
  const first = (c: number) => counts.slice(0, c).reduce((a, b) => a + b, 0)
  const pane = (i: number) => ['-d', specs[i].cwd, '--title', specs[i].name,
    psHost, '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptFiles[i]]
  const args = ['new-tab', ...pane(0)]
  for (let c = 1; c < cols; c++)
    args.push(';', 'split-pane', '-V', '--size',
      ((cols - c) / (cols - c + 1)).toFixed(4), ...pane(first(c)))
  for (let c = cols - 1; c >= 0; c--) {
    for (let r = 1; r < counts[c]; r++)
      args.push(';', 'split-pane', '-H', '--size',
        ((counts[c] - r) / (counts[c] - r + 1)).toFixed(4), ...pane(first(c) + r))
    if (c > 0 && counts.slice(0, c).some(x => x > 1)) args.push(';', 'move-focus', 'left')
  }
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
  const scriptFiles = specs.map(launcherScriptFor)
  mkdirSync(PID_DIR, { recursive: true })
  for (const f of pidFiles) { try { rmSync(f) } catch { /* 无旧文件 */ } }
  specs.forEach((s, i) => writeFileSync(scriptFiles[i], launcherScriptContent(s.command, pidFiles[i])))
  await execa('wt', buildWtArgs(specs, psHost, scriptFiles))
  const pids = await Promise.all(pidFiles.map(readPid))
  return { pids }
}
