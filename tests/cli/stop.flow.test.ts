import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { withState, readState } from '../../src/state/store.js'
import { doStop } from '../../src/cli/commands/stop.js'
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
const itermRun = (): SetRecord['run'] => ({ strategy: 'iterm', startedAt: 't',
  services: [{ name: 'backend', itermSessionId: 'A' }, { name: 'frontend', itermSessionId: 'B' }] })

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  mockExeca.mockReset(); mockExeca.mockResolvedValue({ stdout: '' } as never) })
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.BK_HOME })

describe('doStop', () => {
  it('未分配 worktree → 抛 NOT_IN_WORKTREE', async () => {
    await expect(doStop(ctx, '/nope')).rejects.toMatchObject({ code: 'NOT_IN_WORKTREE' })
  })
  it('无 run → 不报错、不调用 execa', async () => {
    await seed(undefined)
    await expect(doStop(ctx, wt)).resolves.toBeUndefined()
    expect(mockExeca).not.toHaveBeenCalled()
  })
  it('停全部 → close 两个 session、清空 run', async () => {
    await seed(itermRun())
    await doStop(ctx, wt)
    expect(mockExeca).toHaveBeenCalledTimes(2)
    const s = await readState('foo')
    expect(s.sets['2'].run).toBeUndefined()
  })
  it('停单个 → 只 close 该 session、run 保留其余', async () => {
    await seed(itermRun())
    await doStop(ctx, wt, 'backend')
    expect(mockExeca).toHaveBeenCalledTimes(1)
    const s = await readState('foo')
    expect(s.sets['2'].run!.services).toEqual([{ name: 'frontend', itermSessionId: 'B' }])
  })
  it('停一个未在运行的 service → 不报错、不动 run、不调用 execa', async () => {
    await seed(itermRun())
    await doStop(ctx, wt, 'worker')
    expect(mockExeca).not.toHaveBeenCalled()
    const s = await readState('foo')
    expect(s.sets['2'].run!.services).toHaveLength(2)
  })
})
