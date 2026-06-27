import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { withState, readState } from '../../src/state/store.js'
import { doStart } from '../../src/cli/commands/start.js'
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

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  mockExeca.mockReset(); mockExeca.mockResolvedValue({ stdout: 'SID-backend, SID-frontend' } as never) })
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.BK_HOME })

describe('doStart', () => {
  it('未分配 worktree → 抛 NOT_IN_WORKTREE', async () => {
    await expect(doStart(ctx, '/nope', undefined, 'iterm')).rejects.toMatchObject({ code: 'NOT_IN_WORKTREE' })
  })
  it('陈旧 run（探测到句柄已死）→ 清掉孤儿记录并正常启动', async () => {
    // 默认 mock 探测返回 SID-backend/SID-frontend，旧 session 'X' 不在其中 → 判定已死
    await seed({ strategy: 'iterm', startedAt: 't', services: [{ name: 'backend', itermSessionId: 'X' }] })
    await doStart(ctx, wt, undefined, 'iterm')
    const s = await readState('foo')
    expect(s.sets['2'].run).toMatchObject({ strategy: 'iterm',
      services: [{ name: 'backend', itermSessionId: 'SID-backend' }, { name: 'frontend', itermSessionId: 'SID-frontend' }] })
  })

  it('真存活 run → 幂等：不启动、不抛错、保留 run', async () => {
    mockExeca.mockResolvedValue({ stdout: 'A, B' } as never) // 探测到 A/B 均存活
    await seed({ strategy: 'iterm', startedAt: 't',
      services: [{ name: 'backend', itermSessionId: 'A' }, { name: 'frontend', itermSessionId: 'B' }] })
    await doStart(ctx, wt, undefined, 'iterm')
    expect(mockExeca).toHaveBeenCalledTimes(1) // 只探测、不再 osascript 开窗
    const s = await readState('foo')
    expect(s.sets['2'].run!.services).toEqual(
      [{ name: 'backend', itermSessionId: 'A' }, { name: 'frontend', itermSessionId: 'B' }])
  })
  it('iterm 启动成功 → 写入 run（含 session id）', async () => {
    await seed()
    await doStart(ctx, wt, undefined, 'iterm')
    const s = await readState('foo')
    expect(s.sets['2'].run).toMatchObject({ strategy: 'iterm',
      services: [{ name: 'backend', itermSessionId: 'SID-backend' }, { name: 'frontend', itermSessionId: 'SID-frontend' }] })
    expect(typeof s.sets['2'].run!.startedAt).toBe('string')
  })
  it('print 策略 → 不写 run', async () => {
    await seed()
    await doStart(ctx, wt, undefined, 'print')
    const s = await readState('foo')
    expect(s.sets['2'].run).toBeUndefined()
  })
})
