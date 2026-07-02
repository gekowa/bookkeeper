import { describe, it, expect } from 'vitest'
import { buildLaunchSpecs } from '../../src/launch/index.js'
import type { Ctx, SetRecord } from '../../src/core/types.js'
import { injectionModeFor } from '../../src/frameworks/registry.js'

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

describe('buildLaunchSpecs startupArgs 分流', () => {
  const sbCtx: Ctx = { projectRoot: '/x', config: { project_name: 'foo',
    infra: { postgres: { host: 'localhost', port: 5432, username: 'pg', password: 'sec' } },
    services: [{ name: 'api', type: 'springboot', port_base: 10200,
      startCommand: ['mvn', 'spring-boot:run',
        '-Dspring-boot.run.arguments=--server.port={self.port} --spring.datasource.url=jdbc:postgresql://{infra.postgres.host}:{infra.postgres.port}/{db.name}'],
      envs: { SPRING_DATASOURCE_PASSWORD: '{infra.postgres.password}' } }] } }
  const sbSet: SetRecord = { status: 'allocated', owner: { worktree: '/wt', branch: 'x' },
    resources: { api: { port: 10202 }, postgres: { database: 'foo_2' } }, created_at: 't' }

  it('startupArgs：产出插值后的 argv 与 env，无 command', () => {
    const spec = buildLaunchSpecs(sbCtx, sbSet, '/wt')[0]
    expect(spec.command).toBeUndefined()
    expect(spec.argv).toEqual(['mvn', 'spring-boot:run',
      '-Dspring-boot.run.arguments=--server.port=10202 --spring.datasource.url=jdbc:postgresql://localhost:5432/foo_2'])
    expect(spec.env).toEqual({ SPRING_DATASOURCE_PASSWORD: 'sec' })
  })
  it('startupArgs 缺 startCommand → CONFIG_INVALID', () => {
    const bad: Ctx = { ...sbCtx, config: { ...sbCtx.config,
      services: [{ name: 'api', type: 'springboot', port_base: 10200 }] } }
    expect(() => buildLaunchSpecs(bad, sbSet, '/wt')).toThrow(/CONFIG_INVALID|startCommand/)
  })
  it('dotEnv service 仍产出 command，无 argv', () => {
    const spec = buildLaunchSpecs(ctx, set, '/wt').find(s => s.name === 'backend')!
    expect(spec.command).toContain('manage.py runserver')
    expect(spec.argv).toBeUndefined()
  })
})
