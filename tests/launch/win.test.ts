import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
import { spawn } from 'node:child_process'
import { buildWinSpawn, runWin } from '../../src/launch/win.js'
import type { LaunchSpec } from '../../src/launch/index.js'

const mockSpawn = vi.mocked(spawn)
const specs: LaunchSpec[] = [
  { name: 'backend', command: 'uv run x', cwd: 'C:\\wt\\backend', port: 10002 },
  { name: 'frontend', command: 'npm run dev', cwd: 'C:\\wt\\frontend', port: 10102 },
]

describe('buildWinSpawn', () => {
  const r = buildWinSpawn(specs[0], 'powershell')
  it('file = psHost', () => expect(r.file).toBe('powershell'))
  it('args 用 -NoExit -Command 跑原命令', () =>
    expect(r.args).toEqual(['-NoExit', '-Command', 'uv run x']))
  it('opts：cwd / detached / stdio ignore', () => {
    expect(r.opts.cwd).toBe('C:\\wt\\backend')
    expect(r.opts.detached).toBe(true)
    expect(r.opts.stdio).toBe('ignore')
  })
})

describe('runWin', () => {
  beforeEach(() => {
    mockSpawn.mockReset()
    let pid = 1000
    mockSpawn.mockImplementation((() => ({ pid: ++pid, unref() {} })) as never)
  })
  it('每个 service spawn 一次，按序返回 pid', async () => {
    const { pids } = await runWin(specs, 'powershell')
    expect(mockSpawn).toHaveBeenCalledTimes(2)
    expect(pids).toEqual([1001, 1002])
  })
})
