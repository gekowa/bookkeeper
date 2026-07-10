import { describe, it, expect } from 'vitest'
import { buildWtSteps, pidFileFor, launcherScriptFor, launcherScriptContent } from '../../src/launch/wt.js'
import type { LaunchSpec } from '../../src/launch/index.js'

const mk = (n: number): LaunchSpec[] => Array.from({ length: n }, (_, i) => (
  { name: `s${i + 1}`, command: `cmd${i + 1}`, cwd: `C:\\wt\\s${i + 1}`, port: 10000 + i }))
const scripts = (specs: LaunchSpec[]) => specs.map(launcherScriptFor)

describe('运行时文件路径', () => {
  const specs = mk(2)
  it('同 cwd 不同 name → 不同 pidfile', () => {
    expect(pidFileFor(specs[0])).not.toBe(pidFileFor(specs[1]))
  })
  it('pidfile 以 .pid 结尾', () => expect(pidFileFor(specs[0]).endsWith('.pid')).toBe(true))
  it('启动脚本与 pidfile 同 key，以 .ps1 结尾', () => {
    expect(launcherScriptFor(specs[0])).toBe(pidFileFor(specs[0]).replace(/\.pid$/, '.ps1'))
  })
})

describe('launcherScriptContent', () => {
  it('以 UTF-8 BOM 开头（PowerShell 5.1 对无 BOM 文件按 ANSI 解析）', () => {
    expect(launcherScriptContent('x', 'C:\\tmp\\x.pid').startsWith('\uFEFF')).toBe(true)
  })
  it('第一行写宿主 $PID 到 pidfile，第二行原命令', () => {
    expect(launcherScriptContent('npm run dev', 'C:\\tmp\\x.pid'))
      .toBe("\uFEFF$PID | Out-File -Encoding ascii 'C:\\tmp\\x.pid'\nnpm run dev\n")
  })
  it("pidfile 路径中的单引号按 PowerShell 规则转义（' → ''）", () => {
    expect(launcherScriptContent('x', "C:\\it's\\x.pid")).toContain("'C:\\it''s\\x.pid'")
  })
})

describe('buildWtSteps 网格构造', () => {
  it('k=1: 仅一步 new-tab，paneIndex=0', () => {
    const s = mk(1)
    const steps = buildWtSteps(s, 'powershell', scripts(s))
    expect(steps).toHaveLength(1)
    expect(steps[0].args[0]).toBe('new-tab')
    expect(steps[0].paneIndex).toBe(0)
  })
  it('k=2: new-tab + 一次 -V 0.5000；无 -H、无 move-focus', () => {
    const s = mk(2)
    const steps = buildWtSteps(s, 'powershell', scripts(s))
    expect(steps).toHaveLength(2)
    expect(steps[1].args.slice(0, 4)).toEqual(['split-pane', '-V', '--size', '0.5000'])
    expect(steps.some(st => st.args.includes('-H'))).toBe(false)
    expect(steps.some(st => st.args[0] === 'move-focus')).toBe(false)
  })
  it('k=2: pane 参数结构 = -d cwd --title name psHost -NoExit -ExecutionPolicy Bypass -File script', () => {
    const s = mk(2)
    const sf = scripts(s)
    const steps = buildWtSteps(s, 'powershell', sf)
    expect(steps[0].args).toEqual(['new-tab', '-d', 'C:\\wt\\s1', '--title', 's1',
      'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', sf[0]])
  })
  it('k=6（3 列 × 2 行）: 8 步、尺寸序列、2 次 move-focus、paneIndex 构造顺序 [0,2,4,5,3,1]', () => {
    const s = mk(6)
    const steps = buildWtSteps(s, 'pwsh', scripts(s))
    expect(steps).toHaveLength(8)
    const sizes = steps.flatMap(st => { const i = st.args.indexOf('--size'); return i >= 0 ? [st.args[i + 1]] : [] })
    expect(sizes).toEqual(['0.6667', '0.5000', '0.5000', '0.5000', '0.5000'])
    expect(steps.filter(st => st.args[0] === 'move-focus')).toHaveLength(2)
    expect(steps.flatMap(st => (st.paneIndex !== undefined ? [st.paneIndex] : []))).toEqual([0, 2, 4, 5, 3, 1])
  })
  it('k=5（列数 [2,2,1]）: paneIndex 构造顺序 [0,2,4,3,1]', () => {
    const s = mk(5)
    const steps = buildWtSteps(s, 'pwsh', scripts(s))
    expect(steps.flatMap(st => (st.paneIndex !== undefined ? [st.paneIndex] : []))).toEqual([0, 2, 4, 3, 1])
  })
  it('args 不含用户命令文本，也不再含链式分隔符 ;', () => {
    const s: LaunchSpec[] = [
      { name: 'a', command: 'echo "x"; dir && whoami', cwd: 'C:\\wt\\a' },
      { name: 'b', command: 'npm run dev -- --port 1', cwd: 'C:\\wt\\b' },
    ]
    const all = buildWtSteps(s, 'powershell', scripts(s)).flatMap(st => st.args)
    expect(all.join(' ')).not.toContain('echo')
    expect(all.join(' ')).not.toContain('npm run dev')
    expect(all).not.toContain(';')
  })
  it('宿主可执行用传入的 psHost', () => {
    const s = mk(2)
    expect(buildWtSteps(s, 'pwsh', scripts(s)).flatMap(st => st.args)).toContain('pwsh')
  })
})
