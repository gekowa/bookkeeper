import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'
import { reconcileRun } from '../../src/launch/liveness.js'
import type { RunRecord } from '../../src/core/types.js'

const mockExeca = vi.mocked(execa)
beforeEach(() => { mockExeca.mockReset() })

const iterm = (): RunRecord => ({ strategy: 'iterm', startedAt: 't',
  services: [{ name: 'a', itermSessionId: 'A' }, { name: 'b', itermSessionId: 'B' }] })
const tmux = (): RunRecord => ({ strategy: 'tmux', startedAt: 't', tmuxSession: 'bk-x',
  services: [{ name: 'a', tmuxPaneId: '%1' }, { name: 'b', tmuxPaneId: '%2' }] })

describe('reconcileRun (iterm)', () => {
  it('两个 session 都存活 → 原样保留', async () => {
    mockExeca.mockResolvedValue({ stdout: 'A, B' } as never)
    expect(await reconcileRun(iterm())).toEqual(iterm())
  })
  it('只有 A 存活 → 裁剪掉 B', async () => {
    mockExeca.mockResolvedValue({ stdout: 'A' } as never)
    expect(await reconcileRun(iterm())).toEqual({ strategy: 'iterm', startedAt: 't',
      services: [{ name: 'a', itermSessionId: 'A' }] })
  })
  it('无存活（窗口已关，返回空）→ null', async () => {
    mockExeca.mockResolvedValue({ stdout: '' } as never)
    expect(await reconcileRun(iterm())).toBeNull()
  })
  it('osascript 抛错 → 视为无存活，返回 null（不抛）', async () => {
    mockExeca.mockRejectedValue(new Error('boom'))
    expect(await reconcileRun(iterm())).toBeNull()
  })
})

describe('reconcileRun (tmux)', () => {
  it('解析 list-panes 多行，两个 pane 都存活 → 原样保留', async () => {
    mockExeca.mockResolvedValue({ stdout: '%1\n%2' } as never)
    expect(await reconcileRun(tmux())).toEqual(tmux())
  })
  it('只有 %2 存活 → 裁剪掉 %1', async () => {
    mockExeca.mockResolvedValue({ stdout: '%2\n%9' } as never)
    expect(await reconcileRun(tmux())).toEqual({ strategy: 'tmux', startedAt: 't', tmuxSession: 'bk-x',
      services: [{ name: 'b', tmuxPaneId: '%2' }] })
  })
  it('无 tmux server（抛错）→ null', async () => {
    mockExeca.mockRejectedValue(new Error('no server'))
    expect(await reconcileRun(tmux())).toBeNull()
  })
})
