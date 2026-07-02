import { describe, it, expect } from 'vitest'
import { buildWtArgs, pidFileFor } from '../../src/launch/wt.js'
import type { LaunchSpec } from '../../src/launch/index.js'

const specs: LaunchSpec[] = [
  { name: 'backend', command: 'uv run x', cwd: 'C:\\wt\\backend', port: 10002 },
  { name: 'frontend', command: 'npm run dev', cwd: 'C:\\wt\\frontend', port: 10102 },
]
const pf = specs.map(pidFileFor)

describe('pidFileFor', () => {
  it('同 cwd 不同 name → 不同 pidfile', () => {
    expect(pidFileFor(specs[0])).not.toBe(pidFileFor(specs[1]))
  })
  it('以 .pid 结尾', () => expect(pidFileFor(specs[0]).endsWith('.pid')).toBe(true))
})

describe('buildWtArgs', () => {
  const args = buildWtArgs(specs, 'pwsh', pf)
  it('首个子命令是 new-tab，其后用 split-pane', () => {
    expect(args[0]).toBe('new-tab')
    expect(args).toContain('split-pane')
  })
  it('每个 pane 带 -d cwd', () => {
    expect(args).toContain('C:\\wt\\backend')
    expect(args).toContain('C:\\wt\\frontend')
  })
  it('用 ; 分隔 wt 子命令', () => {
    expect(args).toContain(';')
  })
  it('pane 命令在 PowerShell 里先写 $PID 到 pidfile 再跑原命令', () => {
    const joined = args.join('')
    expect(joined).toContain(`$PID | Out-File -Encoding ascii '${pf[0]}'; uv run x`)
    expect(joined).toContain(`$PID | Out-File -Encoding ascii '${pf[1]}'; npm run dev`)
  })
  it('宿主可执行用传入的 psHost', () => {
    expect(args).toContain('pwsh')
  })
  it('startupArgs spec：paneScript 用 PowerShell 渲染 env+argv', () => {
    const a = buildWtArgs([{ name: 'api', cwd: '/wt/api', argv: ['mvn', 'run'], env: { K: 'v' } }], 'pwsh', ['/tmp/p.pid'])
    const joined = a.join(' ')
    expect(joined).toContain(`$env:K='v'; & 'mvn' 'run'`)
  })
})
