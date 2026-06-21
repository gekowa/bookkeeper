import { describe, it, expect } from 'vitest'
import { adapterFor } from '../../src/frameworks/registry.js'
import type { ResourceNames } from '../../src/core/types.js'

const full: ResourceNames = { ports: { backend: 10001 }, database: 'foo_1', redisDb: 1, bucket: 'foo-1' }

describe('adapter.envVars', () => {
  it('django 产 BK_*（取自 names）', () => {
    expect(adapterFor('django').envVars(full))
      .toEqual({ BK_DB_NAME: 'foo_1', BK_REDIS_DB: '1', BK_MINIO_BUCKET: 'foo-1' })
  })
  it('redisPrefix 模式产 BK_REDIS_PREFIX', () => {
    expect(adapterFor('fastapi').envVars({ ports: {}, database: 'foo_1', redisPrefix: 'foo_1_' }))
      .toEqual({ BK_DB_NAME: 'foo_1', BK_REDIS_PREFIX: 'foo_1_' })
  })
  it('无 infra 资源时产空对象', () => {
    expect(adapterFor('arq').envVars({ ports: {} })).toEqual({})
  })
  it('vite 恒空', () => {
    expect(adapterFor('vite').envVars(full)).toEqual({})
  })
})
