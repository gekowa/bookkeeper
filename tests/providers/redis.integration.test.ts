import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import Redis from 'ioredis'
import { hasDocker } from '../helpers/docker.js'

const d = describe.runIf(hasDocker())
let c: StartedTestContainer
d('redis db_number 连通冒烟', () => {
  beforeAll(async () => { c = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start() }, 120_000)
  afterAll(async () => { await c?.stop() })
  it('能 select db 3 并读写', async () => {
    const r = new Redis({ host: c.getHost(), port: c.getMappedPort(6379), db: 3 })
    await r.set('k', 'v'); expect(await r.get('k')).toBe('v'); await r.quit()
  })
})
