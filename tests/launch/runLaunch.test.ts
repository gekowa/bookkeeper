import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/launch/platform.js', () => ({ resolvePsHost: vi.fn() }))
vi.mock('../../src/launch/wt.js', () => ({ runWt: vi.fn() }))
vi.mock('../../src/launch/win.js', () => ({ runWin: vi.fn() }))
import { resolvePsHost } from '../../src/launch/platform.js'
import { runWt } from '../../src/launch/wt.js'
import { runWin } from '../../src/launch/win.js'
import { runLaunch, type LaunchSpec } from '../../src/launch/index.js'

const specs: LaunchSpec[] = [
  { name: 'backend', command: 'a', cwd: 'C:\\wt\\b', port: 10002 },
  { name: 'worker', command: 'c', cwd: 'C:\\wt\\b' },
]

beforeEach(() => {
  vi.mocked(resolvePsHost).mockResolvedValue('pwsh')
  vi.mocked(runWt).mockResolvedValue({ pids: [111, 222] })
  vi.mocked(runWin).mockResolvedValue({ pids: [333, 444] })
})

describe('runLaunch wt / win', () => {
  it('wt：句柄含 strategy=wt、每服务 pid 与 port', async () => {
    const r = await runLaunch(specs, 'wt')
    expect(r).toEqual({ strategy: 'wt', services: [
      { name: 'backend', pid: 111, port: 10002 },
      { name: 'worker', pid: 222, port: undefined },
    ] })
  })
  it('win：句柄含 strategy=win、每服务 pid 与 port', async () => {
    const r = await runLaunch(specs, 'win')
    expect(r).toEqual({ strategy: 'win', services: [
      { name: 'backend', pid: 333, port: 10002 },
      { name: 'worker', pid: 444, port: undefined },
    ] })
  })
})
