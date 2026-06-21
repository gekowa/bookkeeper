// tests/cli/allocate.flow.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { doAllocate, serviceEnvDirs, buildDirEnvs } from '../../src/cli/commands/allocate.js'
import { readState } from '../../src/state/store.js'
import { createPortProvider } from '../../src/providers/port.js'
import { fakeProvider } from '../helpers/fakeProvider.js'
import type { Ctx, ResourceNames } from '../../src/core/types.js'

let home: string, wt: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  wt = mkdtempSync(join(tmpdir(), 'wt-'))
})
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(wt, { recursive: true, force: true }); delete process.env.BK_HOME })

const ctx = (): Ctx => ({ projectRoot: wt, config: {
  project_name: 'foo',
  services: [{ name: 'backend', type: 'django', port_base: 10000 }],
  infra: {},
}})

// port + 一个产 database 的 fake provider（避免连真实 DB，又能让后端写出 BK_DB_NAME 块）
const provs = () => [createPortProvider(), fakeProvider({ kind: 'pg', plan: () => ({ database: 'foo_1' }) })]

describe('doAllocate', () => {
  it('分配号 1、写 .env 标记块（含 BK_DB_NAME）、写 state 为 allocated', async () => {
    const n = await doAllocate(ctx(), wt, 'feature/x', provs())
    expect(n).toBe(1)
    const env = readFileSync(join(wt, '.env'), 'utf8')
    expect(env).toContain('# >>> bk managed >>>')
    expect(env).toContain('BK_DB_NAME=foo_1')
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
    expect(s.sets['1']).toBeUndefined()
  })

  it('service 有 dir → 写到子目录 .env、不写 worktree 根', async () => {
    mkdirSync(join(wt, 'backend'))
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend' }] } }
    await doAllocate(c, wt, 'feature/x', provs())
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
    await doAllocate(c, wt, 'feature/x', provs())
    expect(existsSync(join(wt, 'backend', '.env'))).toBe(true)
  })
})

describe('buildDirEnvs', () => {
  const names: ResourceNames = { ports: { backend: 10001, frontend: 10101 }, database: 'foo_1' }

  it('前端只得 VITE_API_BASE、不含任何 BK_', () => {
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [
        { name: 'backend', type: 'django', port_base: 10000, dir: 'backend' },
        { name: 'frontend', type: 'vite', port_base: 10100, dir: 'frontend',
          envs: { VITE_API_BASE: 'http://localhost:{backend.port}' } },
      ] } }
    const map = buildDirEnvs(c, names)
    expect(map.get('frontend')).toEqual({ VITE_API_BASE: 'http://localhost:10001' })
    expect(map.get('backend')).toEqual({ BK_DB_NAME: 'foo_1' })
  })

  it('vite 无 envs → 该目录不进 map（空块不写）', () => {
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [{ name: 'frontend', type: 'vite', port_base: 10100, dir: 'frontend' }] } }
    const map = buildDirEnvs(c, names)
    expect(map.has('frontend')).toBe(false)
  })
})
