import { describe, it, expect } from 'vitest'
import { buildWtArgs, pidFileFor, launcherScriptFor, launcherScriptContent } from '../../src/launch/wt.js'
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
  it('以 UTF-8 BOM 开头（PowerShell 5.1 无 BOM 按 ANSI 解析）', () => {
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

describe('buildWtArgs 网格构造', () => {
  it('k=1: 仅 new-tab，无 split-pane/move-focus', () => {
    const s = mk(1)
    const args = buildWtArgs(s, 'powershell', scripts(s))
    expect(args[0]).toBe('new-tab')
    expect(args).not.toContain('split-pane')
    expect(args).not.toContain('move-focus')
  })
  it('k=2: pane 参数结构 = -d cwd --title name psHost -NoExit -ExecutionPolicy Bypass -File script', () => {
    const s = mk(2)
    const sf = scripts(s)
    const args = buildWtArgs(s, 'powershell', sf)
    expect(args.slice(0, 11)).toEqual(['new-tab', '-d', 'C:\\wt\\s1', '--title', 's1',
      'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', sf[0]])
  })
  it('k=2: 一次 -V 对半切，无 -H、无 move-focus', () => {
    const s = mk(2)
    const args = buildWtArgs(s, 'powershell', scripts(s))
    expect(args.filter(a => a === 'split-pane')).toHaveLength(1)
    expect(args).toContain('-V')
    expect(args).toContain('0.5000')
    expect(args).not.toContain('-H')
    expect(args).not.toContain('move-focus')
  })
  it('k=6（3 列 × 2 行）: 5 次 split、尺寸序列、2 次 move-focus', () => {
    const s = mk(6)
    const args = buildWtArgs(s, 'pwsh', scripts(s))
    expect(args.filter(a => a === 'split-pane')).toHaveLength(5)
    const sizes = args.flatMap((a, i) => (a === '--size' ? [args[i + 1]] : []))
    expect(sizes).toEqual(['0.6667', '0.5000', '0.5000', '0.5000', '0.5000'])
    expect(args.filter(a => a === 'move-focus')).toHaveLength(2)
  })
  it('k=5（列数 [2,2,1]）: 服务按列优先落格，构造顺序 = s1,s3,s5,s4,s2', () => {
    const s = mk(5)
    const sf = scripts(s)
    const args = buildWtArgs(s, 'pwsh', sf)
    const seq = args.filter(a => sf.includes(a)).map(a => sf.indexOf(a) + 1)
    expect(seq).toEqual([1, 3, 5, 4, 2])
  })
  it('argv 不含用户命令文本；; 仅作为独立的子命令分隔符元素出现', () => {
    const s: LaunchSpec[] = [
      { name: 'a', command: 'echo "x"; dir && whoami', cwd: 'C:\\wt\\a' },
      { name: 'b', command: 'npm run dev -- --port 1', cwd: 'C:\\wt\\b' },
    ]
    const args = buildWtArgs(s, 'powershell', scripts(s))
    const joined = args.join(' ')
    expect(joined).not.toContain('echo')
    expect(joined).not.toContain('npm run dev')
    for (const a of args) if (a.includes(';')) expect(a).toBe(';')
  })
  it('宿主可执行用传入的 psHost', () => {
    const s = mk(2)
    expect(buildWtArgs(s, 'pwsh', scripts(s))).toContain('pwsh')
  })
})
