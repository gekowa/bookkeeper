import { describe, it, expect } from 'vitest'
import { buildLaunchSpecs } from '../../src/launch/index.js'
import type { Ctx, SetRecord } from '../../src/core/types.js'

const ctx: Ctx = { projectRoot: '/x', config: {
  project_name: 'foo',
  services: [
    { name: 'backend', type: 'django', port_base: 10000 },
    { name: 'frontend', type: 'vite', port_base: 10100 },
  ], infra: {} }}
const set: SetRecord = { status: 'allocated', owner: { worktree: '/wt', branch: 'x' },
  resources: { backend: { port: 10002 }, frontend: { port: 10102 } }, created_at: 'x' }

describe('buildLaunchSpecs', () => {
  it('据 set 端口生成各 service 命令', () => {
    const specs = buildLaunchSpecs(ctx, set, '/wt')
    expect(specs[0].command).toBe('uv run python manage.py runserver 0.0.0.0:10002')
    expect(specs[1].command).toBe('npx vite --port 10102 --strictPort')
    expect(specs[0].cwd).toBe('/wt')
  })
  it('only 过滤单个 service', () => {
    expect(buildLaunchSpecs(ctx, set, '/wt', 'frontend')).toHaveLength(1)
  })
  it('用 dir 解析 cwd', () => {
    const ctxDir: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
      services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend' }] } }
    const setDir: SetRecord = { status: 'allocated', owner: { worktree: '/wt', branch: 'x' },
      resources: { backend: { port: 10002 } }, created_at: 'x' }
    expect(buildLaunchSpecs(ctxDir, setDir, '/wt')[0].cwd).toBe('/wt/backend')
  })
  it('无端口 worker：用 adapter 默认命令、cwd 取 dir', () => {
    const ctxW: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
      services: [{ name: 'worker', type: 'arq', app: 'app.worker', dir: 'backend' }] } }
    const setW: SetRecord = { status: 'allocated', owner: { worktree: '/wt', branch: 'x' },
      resources: {}, created_at: 'x' }
    const spec = buildLaunchSpecs(ctxW, setW, '/wt')[0]
    expect(spec.command).toBe('uv run arq app.worker.WorkerSettings')
    expect(spec.cwd).toBe('/wt/backend')
  })
  it('command 含 {port} 但无端口 → 抛 CONFIG_INVALID', () => {
    const ctxBad: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
      services: [{ name: 'worker', type: 'arq', command: 'run --port {port}', dir: 'backend' }] } }
    const setBad: SetRecord = { status: 'allocated', owner: { worktree: '/wt', branch: 'x' },
      resources: {}, created_at: 'x' }
    expect(() => buildLaunchSpecs(ctxBad, setBad, '/wt')).toThrow(/CONFIG_INVALID|port/)
  })
  it('无端口 worker + 自定义 command（不含 {port}）→ 命令原样保留', () => {
    const ctxC: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
      services: [{ name: 'worker', type: 'arq', command: 'uv run arq app.worker.WorkerSettings', dir: 'backend' }] } }
    const setC: SetRecord = { status: 'allocated', owner: { worktree: '/wt', branch: 'x' },
      resources: {}, created_at: 'x' }
    const spec = buildLaunchSpecs(ctxC, setC, '/wt')[0]
    expect(spec.command).toBe('uv run arq app.worker.WorkerSettings')
    expect(spec.cwd).toBe('/wt/backend')
  })
})
