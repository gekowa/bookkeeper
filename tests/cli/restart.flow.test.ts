import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { withState, readState } from '../../src/state/store.js'
import { doRestart } from '../../src/cli/commands/restart.js'
import type { Ctx, SetRecord } from '../../src/core/types.js'

const mockExeca = vi.mocked(execa)
let home: string
const wt = '/wt'
const ctx: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
  services: [{ name: 'backend', type: 'django', port_base: 10000 },
             { name: 'frontend', type: 'vite', port_base: 10100 }] } }

const seed = (run?: SetRecord['run']) => withState('foo', s => {
  s.sets['2'] = { status: 'allocated', owner: { worktree: wt, branch: 'x' },
    resources: { backend: { port: 10002 }, frontend: { port: 10102 } }, created_at: 't', run }
})
const itermRun = (): SetRecord['run'] => ({ strategy: 'iterm', startedAt: 't0',
  services: [{ name: 'backend', itermSessionId: 'A' }, { name: 'frontend', itermSessionId: 'B' }] })

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  mockExeca.mockReset() })
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.BK_HOME })

describe('doRestart', () => {
  it('未分配 worktree → 抛 NOT_IN_WORKTREE', async () => {
    mockExeca.mockResolvedValue({ stdout: '' } as never)
    await expect(doRestart(ctx, '/nope')).rejects.toMatchObject({ code: 'NOT_IN_WORKTREE' })
  })

  it('停全部 + 重启 → close 旧 session 后用新 session id 重写整条 run', async () => {
    await seed(itermRun())
    // 前两次调用是 close（停全部），第三次是 osascript 启动并返回新 session id
    mockExeca
      .mockResolvedValueOnce({ stdout: '' } as never)
      .mockResolvedValueOnce({ stdout: '' } as never)
      .mockResolvedValueOnce({ stdout: 'NB, NF' } as never)
    await doRestart(ctx, wt)
    const s = await readState('foo')
    expect(s.sets['2'].run).toMatchObject({ strategy: 'iterm',
      services: [{ name: 'backend', itermSessionId: 'NB' }, { name: 'frontend', itermSessionId: 'NF' }] })
  })

  it('无 run → 退化为 start，用 force 之外的 env 探测；写入新 run', async () => {
    await seed(undefined)
    mockExeca.mockResolvedValue({ stdout: 'NB, NF' } as never)
    await doRestart(ctx, wt, undefined, { __platform: 'darwin', TERM_PROGRAM: 'iTerm.app' } as NodeJS.ProcessEnv)
    const s = await readState('foo')
    expect(s.sets['2'].run!.strategy).toBe('iterm')
    expect(s.sets['2'].run!.services).toHaveLength(2)
  })

  it('单服务重启 → 只 close 该 session、新句柄并回、其余保留', async () => {
    await seed(itermRun())
    mockExeca
      .mockResolvedValueOnce({ stdout: '' } as never)   // close backend
      .mockResolvedValueOnce({ stdout: 'NB' } as never)  // 重启 backend（单 service → 单 id）
    await doRestart(ctx, wt, 'backend', { __platform: 'darwin', TERM_PROGRAM: 'iTerm.app' } as NodeJS.ProcessEnv)
    const s = await readState('foo')
    const byName = Object.fromEntries(s.sets['2'].run!.services.map(x => [x.name, x.itermSessionId]))
    expect(byName).toEqual({ frontend: 'B', backend: 'NB' })
  })
})
