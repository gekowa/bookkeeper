import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'
import { stopRun } from '../../src/launch/stop.js'
import type { RunRecord } from '../../src/core/types.js'

const mockExeca = vi.mocked(execa)
beforeEach(() => { mockExeca.mockReset(); mockExeca.mockResolvedValue({ stdout: '' } as never) })

const iterm = (): RunRecord => ({ strategy: 'iterm', startedAt: 't',
  services: [{ name: 'a', itermSessionId: 'A' }, { name: 'b', itermSessionId: 'B' }] })
const tmux = (): RunRecord => ({ strategy: 'tmux', startedAt: 't', tmuxSession: 'bk-x',
  services: [{ name: 'a', tmuxPaneId: '%1' }, { name: 'b', tmuxPaneId: '%2' }] })

describe('stopRun', () => {
  it('iterm 停全部 → 逐个 close session，返回 null', async () => {
    const rem = await stopRun(iterm())
    const scripts = mockExeca.mock.calls.map(c => (c[1] as string[])[1])
    expect(scripts[0]).toBe('tell application "iTerm2" to tell session id "A" to close')
    expect(scripts[1]).toBe('tell application "iTerm2" to tell session id "B" to close')
    expect(rem).toBeNull()
  })
  it('iterm 停单个 → 只 close 该 session，返回剩余', async () => {
    const rem = await stopRun(iterm(), 'a')
    expect(mockExeca).toHaveBeenCalledTimes(1)
    expect((mockExeca.mock.calls[0][1] as string[])[1]).toContain('"A"')
    expect(rem).toEqual({ strategy: 'iterm', startedAt: 't', services: [{ name: 'b', itermSessionId: 'B' }] })
  })
  it('tmux 停全部 → kill-session，返回 null', async () => {
    const rem = await stopRun(tmux())
    expect(mockExeca).toHaveBeenCalledWith('tmux', ['kill-session', '-t', 'bk-x'])
    expect(rem).toBeNull()
  })
  it('tmux 停单个 → kill-pane，返回剩余', async () => {
    const rem = await stopRun(tmux(), 'b')
    expect(mockExeca).toHaveBeenCalledWith('tmux', ['kill-pane', '-t', '%2'])
    expect(rem).toEqual({ strategy: 'tmux', startedAt: 't', tmuxSession: 'bk-x', services: [{ name: 'a', tmuxPaneId: '%1' }] })
  })
  it('句柄已失效（execa 抛错）→ 吞错、仍返回剩余/ null', async () => {
    mockExeca.mockRejectedValue(new Error('session not found'))
    await expect(stopRun(iterm())).resolves.toBeNull()
  })

  it('win：按 pid → taskkill /PID /T /F', async () => {
    const run = { strategy: 'win' as const, startedAt: 't',
      services: [{ name: 'a', pid: 4321, port: 10002 }] }
    const rem = await stopRun(run)
    expect(mockExeca).toHaveBeenCalledWith('taskkill', ['/PID', '4321', '/T', '/F'])
    expect(rem).toBeNull()
  })

  it('wt：无 pid 但有 port → 先 Get-NetTCPConnection 查属主再 taskkill', async () => {
    mockExeca.mockReset()
    // 第一次（powershell 查端口）返回 pid 文本；其余返回空
    mockExeca.mockResolvedValueOnce({ stdout: '9999' } as never)
                .mockResolvedValue({ stdout: '' } as never)
    const run = { strategy: 'wt' as const, startedAt: 't',
      services: [{ name: 'a', port: 10002 }] }
    await stopRun(run)
    const files = mockExeca.mock.calls.map(c => c[0])
    expect(files).toContain('powershell')
    expect(mockExeca).toHaveBeenCalledWith('taskkill', ['/PID', '9999', '/T', '/F'])
  })

  it('win：无 pid 无 port → 不调用 taskkill（幂等跳过）', async () => {
    const run = { strategy: 'win' as const, startedAt: 't',
      services: [{ name: 'a' }] }
    await stopRun(run)
    const files = mockExeca.mock.calls.map(c => c[0])
    expect(files).not.toContain('taskkill')
  })
})
