import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import { createPostgresProvider } from '../../src/providers/postgres.js'
import { hasDocker } from '../helpers/docker.js'
import type { Ctx } from '../../src/core/types.js'

const d = describe.runIf(hasDocker())
let pg: StartedPostgreSqlContainer
let ctx: Ctx

d('postgres provider', () => {
  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start()
    ctx = {
      projectRoot: '/x',
      config: {
        project_name: 'foo', services: [],
        infra: { postgres: { host: pg.getHost(), port: pg.getPort(), username: pg.getUsername(), password: pg.getPassword() } },
      },
    }
  }, 120_000)
  afterAll(async () => { await pg?.stop() })

  it('provision 建库、probe 复测为 false、destroy 删库', async () => {
    const p = createPostgresProvider()
    expect(p.plan(2, ctx).database).toBe('foo_2')
    expect(await p.probe(2, ctx)).toBe(true)
    await p.provision(2, ctx)
    expect(await p.probe(2, ctx)).toBe(false)   // 已存在 → 跳号
    expect(p.envVars(2, ctx).BK_DB_NAME).toBe('foo_2')
    await p.destroy(2, ctx)
    expect(await p.probe(2, ctx)).toBe(true)
  })
})
