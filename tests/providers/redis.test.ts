import { describe, it, expect } from 'vitest'
import { createRedisProvider } from '../../src/providers/redis.js'
import type { Ctx } from '../../src/core/types.js'

const ctx = (iso: 'key_prefix' | 'db_number'): Ctx => ({
  projectRoot: '/x',
  config: { project_name: 'foo', services: [],
    infra: { redis: { host: 'localhost', port: 6379, isolation: iso } } },
})

describe('redis provider key_prefix', () => {
  it('plan 产前缀、envVars 含 BK_REDIS_PREFIX', () => {
    const p = createRedisProvider()
    expect(p.plan(2, ctx('key_prefix')).redisPrefix).toBe('foo_2_')
    expect(p.envVars(2, ctx('key_prefix')).BK_REDIS_PREFIX).toBe('foo_2_')
  })
  it('key_prefix 下 probe 恒 true（无副作用）', async () => {
    expect(await createRedisProvider().probe(99, ctx('key_prefix'))).toBe(true)
  })
})

describe('redis provider db_number', () => {
  it('n>15 时 probe 抛 REDIS_DB_EXHAUSTED', async () => {
    await expect(createRedisProvider().probe(16, ctx('db_number'))).rejects.toThrow(/REDIS_DB_EXHAUSTED|0-15/)
  })
  it('plan 产 redisDb、envVars 含 BK_REDIS_DB', () => {
    const p = createRedisProvider()
    expect(p.plan(3, ctx('db_number')).redisDb).toBe(3)
    expect(p.envVars(3, ctx('db_number')).BK_REDIS_DB).toBe('3')
  })
})
