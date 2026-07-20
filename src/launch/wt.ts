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
// 以 UTF-8 BOM 开头——PowerShell 5.1 对无 BOM 文件按 ANSI 解析，非 ASCII 内容会乱码；pwsh 不受影响。
// 命令以 -File 落盘执行——wt argv 中不出现用户命令文本，
// 从根上避免 execa→wt→PowerShell 三层引号/元字符（; " & …）转义问题。
export function launcherScriptContent(command: string, pidFile: string): string {
  const escaped = pidFile.replace(/'/g, "''")
  return `\uFEFF$PID | Out-File -Encoding ascii '${escaped}'\n${command}\n`
}

// 一步 = 一次 wt 调用：args 为子命令参数（不含 wt/-w）；paneIndex = 该步创建的 pane 对应的 service 下标（move-focus 无）。
export interface WtStep { args: string[]; paneIndex?: number }

// 构建网格构造步骤（planGrid 同款均匀网格，列优先），聚焦相对：
// 1) new-tab = 格(0,0)；2) 左→右切等宽列（-V）；3) 最右列→左逐列自上而下切行（-H），
// 列间 move-focus left（左邻列此时必为单一整列 pane，方向无歧义）。
// 不拼单条子命令链：WT 对链式 split-pane 的焦点指派与 pane 建立异步竞速（真机实测仅 ~1/5 布局正确），
// 由 runWt 逐步下发并以 pidfile 门控（pane 内 PowerShell 已启动 ⇒ 焦点已落定）。
export function buildWtSteps(specs: LaunchSpec[], psHost: string, scriptFiles: string[]): WtStep[] {
  const counts = gridShape(specs.length)
  const cols = counts.length
  // 列优先下标：第 c 列首格的 service 下标 = 前面各列格数之和
  const first = (c: number) => counts.slice(0, c).reduce((a, b) => a + b, 0)
  const pane = (i: number) => ['-d', specs[i].cwd, '--title', specs[i].name,
    psHost, '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptFiles[i]]
  const steps: WtStep[] = [{ args: ['new-tab', ...pane(0)], paneIndex: 0 }]
  for (let c = 1; c < cols; c++)
    steps.push({
      args: ['split-pane', '-V', '--size', ((cols - c) / (cols - c + 1)).toFixed(4), ...pane(first(c))],
      paneIndex: first(c),
    })
  for (let c = cols - 1; c >= 0; c--) {
    for (let r = 1; r < counts[c]; r++)
      steps.push({
        args: ['split-pane', '-H', '--size', ((counts[c] - r) / (counts[c] - r + 1)).toFixed(4), ...pane(first(c) + r)],
        paneIndex: first(c) + r,
      })
    if (c > 0 && counts.slice(0, c).some(x => x > 1)) steps.push({ args: ['move-focus', 'left'] })
  }
  return steps
}

// 轮询读取 pidfile（默认最多 5s，每 50ms 一次），拿不到返回 undefined。
async function readPid(pidFile: string, timeoutMs = 5000): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (!Number.isNaN(pid)) return pid
    } catch { /* 还没写出来 */ }
    await new Promise(r => setTimeout(r, 50))
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
  // 具名新窗口：确定路由到本次启动的窗口，不受用户 windowingBehavior 设定影响
  const win = `bk-${Date.now()}`
  const pids: (number | undefined)[] = new Array(specs.length).fill(undefined)
  for (const step of buildWtSteps(specs, psHost, scriptFiles)) {
    await execa('wt', ['-w', win, ...step.args])
    // 门控：等 pane 写出 pidfile（pane 已就绪、焦点已落定）再发下一步；拿不到则记 undefined 并继续
    if (step.paneIndex !== undefined) pids[step.paneIndex] = await readPid(pidFiles[step.paneIndex])
  }
  return { pids }
}
