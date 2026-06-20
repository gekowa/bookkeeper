// tests/providers/minio.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import { createMinioProvider } from '../../src/providers/minio.js'
import { hasDocker } from '../helpers/docker.js'
import type { Ctx } from '../../src/core/types.js'

const d = describe.runIf(hasDocker())
let c: StartedTestContainer
let ctx: Ctx
d('minio provider', () => {
  beforeAll(async () => {
    c = await new GenericContainer('minio/minio:latest')
      .withCommand(['server', '/data']).withExposedPorts(9000)
      .withEnvironment({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' })
      .start()
    ctx = { projectRoot: '/x', config: { project_name: 'foo', services: [],
      infra: { minio: { endpoint: `${c.getHost()}:${c.getMappedPort(9000)}`, access_key: 'minioadmin', secret_key: 'minioadmin' } } } }
  }, 120_000)
  afterAll(async () => { await c?.stop() })

  it('plan 用连字符、provision/probe/destroy 闭环', async () => {
    const p = createMinioProvider()
    expect(p.plan(2, ctx).bucket).toBe('foo-2')
    expect(await p.probe(2, ctx)).toBe(true)
    await p.provision(2, ctx)
    expect(await p.probe(2, ctx)).toBe(false)
    await p.destroy(2, ctx)
    expect(await p.probe(2, ctx)).toBe(true)
  })
})
