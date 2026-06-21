// tests/cli/allocate.flow.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { doAllocate, serviceEnvDirs } from '../../src/cli/commands/allocate.js'
import { readState } from '../../src/state/store.js'
import { fakeProvider } from '../helpers/fakeProvider.js'
import type { Ctx } from '../../src/core/types.js'

let home: string, wt: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  wt = mkdtempSync(join(tmpdir(), 'wt-'))
})
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(wt, { recursive: true, force: true }); delete process.env.BK_HOME })

const ctx = (): Ctx => ({ projectRoot: wt, config: {
  project_name: 'foo',
  services: [{ name: 'backend', type: 'django', port_base: 10000 }],
  infra: {},   // 仅 port provider，无外部依赖
}})

describe('doAllocate', () => {
  it('分配号 1、写 .env 标记块、写 state 为 allocated', async () => {
    const n = await doAllocate(ctx(), wt, 'feature/x')
    expect(n).toBe(1)
    const env = readFileSync(join(wt, '.env'), 'utf8')
    expect(env).toContain('# >>> bk managed >>>')
    const s = await readState('foo')
    expect(s.sets['1'].status).toBe('allocated')
    expect(s.sets['1'].owner?.worktree).toBe(wt)
    expect((s.sets['1'].resources['backend'] as any).port).toBe(10001)
  })

  it('provision 后写 .env 失败 → 回滚已建资源、不持久化 state', async () => {
    const destroy = vi.fn(async () => {})
    const fake = fakeProvider({ kind: 'fake', provision: async () => {}, destroy, plan: () => ({ database: 'x' }) })
    const badDir = join(wt, 'does-not-exist-subdir', 'nested')  // parent missing → writeEnvBlock throws ENOENT
    await expect(doAllocate(ctx(), badDir, 'feature/x', [fake])).rejects.toThrow()
    expect(destroy).toHaveBeenCalledWith(1, expect.anything())
    const s = await readState('foo')
    expect(s.sets['1']).toBeUndefined()  // nothing persisted
  })

  it('service 有 dir → 写到子目录 .env、不写 worktree 根', async () => {
    mkdirSync(join(wt, 'backend'))
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend' }] } }
    await doAllocate(c, wt, 'feature/x')
    expect(existsSync(join(wt, 'backend', '.env'))).toBe(true)
    expect(readFileSync(join(wt, 'backend', '.env'), 'utf8')).toContain('# >>> bk managed >>>')
    expect(existsSync(join(wt, '.env'))).toBe(false)
  })

  it('多个 service 共享同一 dir → 去重，只写一份', async () => {
    mkdirSync(join(wt, 'backend'))
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [
        { name: 'backend', type: 'fastapi', port_base: 10000, app: 'app.main:app', dir: 'backend' },
        { name: 'worker', type: 'arq', app: 'app.worker', dir: 'backend' },
      ] } }
    expect(serviceEnvDirs(c)).toEqual(['backend'])
    await doAllocate(c, wt, 'feature/x')
    expect(existsSync(join(wt, 'backend', '.env'))).toBe(true)
  })
})
