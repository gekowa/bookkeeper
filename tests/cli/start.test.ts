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
    expect(specs[1].command).toBe('npm run dev -- --port 10102')
    expect(specs[0].cwd).toBe('/wt')
  })
  it('only 过滤单个 service', () => {
    expect(buildLaunchSpecs(ctx, set, '/wt', 'frontend')).toHaveLength(1)
  })
})
