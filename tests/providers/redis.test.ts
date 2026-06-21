import { describe, it, expect } from 'vitest'
import { createRedisProvider } from '../../src/providers/redis.js'
import type { Ctx } from '../../src/core/types.js'

const ctx = (iso: 'key_prefix' | 'db_number'): Ctx => ({
  projectRoot: '/x',
  config: { project_name: 'foo', services: [],
    infra: { redis: { host: 'localhost', port: 6379, isolation: iso } } },
})

describe('redis provider key_prefix', () => {
  it('plan 产前缀', () => {
    const p = createRedisProvider()
    expect(p.plan(2, ctx('key_prefix')).redisPrefix).toBe('foo_2_')
  })
  it('key_prefix 下 probe 恒 true（无副作用）', async () => {
    expect(await createRedisProvider().probe(99, ctx('key_prefix'))).toBe(true)
  })
})

describe('redis provider db_number', () => {
  it('n>15 时 probe 抛 REDIS_DB_EXHAUSTED', async () => {
    await expect(createRedisProvider().probe(16, ctx('db_number'))).rejects.toThrow(/REDIS_DB_EXHAUSTED|0-15/)
  })
  it('n=15 时 probe 返回 true（边界合法，不抛）', async () => {
    expect(await createRedisProvider().probe(15, ctx('db_number'))).toBe(true)
  })
  it('plan 产 redisDb', () => {
    const p = createRedisProvider()
    expect(p.plan(3, ctx('db_number')).redisDb).toBe(3)
  })
})

describe('redis provider isolation 缺省', () => {
  const ctxNoIso: Ctx = {
    projectRoot: '/x',
    config: { project_name: 'foo', services: [],
      infra: { redis: { host: 'localhost', port: 6379 } } },
  }
  it('未配置 isolation 时默认 db_number：plan 产 redisDb', () => {
    const p = createRedisProvider()
    expect(p.plan(3, ctxNoIso).redisDb).toBe(3)
    expect(p.plan(3, ctxNoIso).redisPrefix).toBeUndefined()
  })
  it('缺省下 n>15 仍抛 REDIS_DB_EXHAUSTED', async () => {
    await expect(createRedisProvider().probe(16, ctxNoIso)).rejects.toThrow(/REDIS_DB_EXHAUSTED|0-15/)
  })
})

describe('redis provider cfg guard', () => {
  it('infra 无 redis 时 probe 抛 CONFIG_INVALID', async () => {
    const ctxNoRedis: Ctx = {
      projectRoot: '/x',
      config: { project_name: 'foo', services: [], infra: {} },
    }
    await expect(createRedisProvider().probe(1, ctxNoRedis)).rejects.toThrow(/CONFIG_INVALID|redis/)
  })
})
