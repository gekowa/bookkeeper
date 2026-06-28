import { describe, it, expect } from 'vitest'
import { buildLaunchSpecs } from '../../src/launch/index.js'
import type { Ctx, SetRecord } from '../../src/core/types.js'

const ctx: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
  services: [
    { name: 'backend', type: 'django', port_base: 10000 },
    { name: 'worker', type: 'arq', app: 'app.worker' },
  ] } }

const set: SetRecord = { status: 'allocated', owner: { worktree: '/wt', branch: 'x' },
  resources: { backend: { port: 10002 } }, created_at: 't' }

describe('buildLaunchSpecs port 透传', () => {
  it('有端口的 service：spec.port = 已分配端口', () => {
    const specs = buildLaunchSpecs(ctx, set, '/wt')
    expect(specs.find(s => s.name === 'backend')!.port).toBe(10002)
  })
  it('无端口的 worker：spec.port = undefined', () => {
    const specs = buildLaunchSpecs(ctx, set, '/wt')
    expect(specs.find(s => s.name === 'worker')!.port).toBeUndefined()
  })
})
