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
    const { n } = await doAllocate(ctx(), wt, 'feature/x', provs())
    expect(n).toBe(1)
    const env = readFileSync(join(wt, '.env'), 'utf8')
    expect(env).toContain('# >>> bk managed >>>')
    expect(env).toContain('BK_DB_NAME=foo_1')
    const s = await readState('foo')
    expect(s.sets['1'].status).toBe('allocated')
    expect(s.sets['1'].owner?.worktree).toBe(wt)
    expect((s.sets['1'].resources['backend'] as any).port).toBe(10001)
  })

  it('同目录二次 allocate → 幂等：复用既有 Set、不新增、不重 provision、不覆盖 .env', async () => {
    const provision = vi.fn(async () => {})
    const fake = fakeProvider({ kind: 'fake', provision, plan: () => ({ database: 'x' }) })

    const first = await doAllocate(ctx(), wt, 'feature/x', [fake])
    const env1 = readFileSync(join(wt, '.env'), 'utf8')
    expect(provision).toHaveBeenCalledTimes(1)

    const second = await doAllocate(ctx(), wt, 'feature/x', [fake])
    expect(second.reused).toBe(true)
    expect(second.n).toBe(first.n)
    expect(provision).toHaveBeenCalledTimes(1)  // 未再 provision

    const s = await readState('foo')
    expect(Object.keys(s.sets)).toHaveLength(1)  // 未新增 Set
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe(env1)  // .env 未被覆盖
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
    const merged = readFileSync(join(wt, 'backend', '.env'), 'utf8')
    expect(merged.match(/# >>> bk managed >>>/g)?.length).toBe(1)
  })

  it('reused=false → allocate 后跑 post_allocate（注入 BK_N）', async () => {
    mkdirSync(join(wt, 'backend'))
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend',
        post_allocate: `node -e "require('fs').writeFileSync('hook.txt', process.env.BK_N)"` }] } }
    await doAllocate(c, wt, 'feature/x', provs())
    expect(readFileSync(join(wt, 'backend', 'hook.txt'), 'utf8').trim()).toBe('1')
  })

  it('幂等命中（reused）不重跑钩子', async () => {
    mkdirSync(join(wt, 'backend'))
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend',
        post_allocate: 'echo x >> hook.txt' }] } }
    await doAllocate(c, wt, 'feature/x', provs())
    await doAllocate(c, wt, 'feature/x', provs())  // reused
    const lines = readFileSync(join(wt, 'backend', 'hook.txt'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
  })

  it('opts.hook=false → 跳过钩子', async () => {
    mkdirSync(join(wt, 'backend'))
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend',
        post_allocate: 'echo x > hook.txt' }] } }
    await doAllocate(c, wt, 'feature/x', provs(), { hook: false })
    expect(existsSync(join(wt, 'backend', 'hook.txt'))).toBe(false)
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

describe('buildDirEnvs 跳过 startupArgs', () => {
  const names: ResourceNames = { ports: { api: 10202, web: 10102 }, database: 'foo_2' }
  const ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
    services: [
      { name: 'api', type: 'springboot', dir: 'api', port_base: 10200,
        envs: { SPRING_DATASOURCE_PASSWORD: 'sec' } },
      { name: 'web', type: 'vite', dir: 'web', port_base: 10100,
        envs: { VITE_API_BASE: 'http://localhost:{api.port}' } },
    ] } } as unknown as Ctx

  it('startupArgs service 不产生 .env 内容，dotEnv service 正常', () => {
    const byDir = buildDirEnvs(ctx, names)
    expect(byDir.has('api')).toBe(false)
    expect(byDir.get('web')).toEqual({ VITE_API_BASE: 'http://localhost:10202' })
  })
})
