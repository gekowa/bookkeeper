import { describe, it, expect } from 'vitest'
import { interpolateEnvs, resolveTokens } from '../../src/inject/interpolate.js'
import type { ResolveContext, ServiceConfig } from '../../src/core/types.js'

const self: ServiceConfig = { name: 'api', type: 'springboot', port_base: 10200 }
const rc: ResolveContext = {
  self,
  names: { ports: { api: 10202, backend: 10001 }, database: 'foo_2', redisDb: 2, bucket: 'foo-2' },
  infra: { postgres: { host: 'localhost', port: 5432, username: 'pg', password: 'sec' },
    redis: { host: 'localhost', port: 6379 }, minio: { endpoint: 'localhost:9000', access_key: 'ak', secret_key: 'sk' } },
}

describe('resolveTokens', () => {
  it('{self.port} 与 {port} 别名都解析本 service 端口', () => {
    expect(resolveTokens('{self.port}', rc, 'x')).toBe('10202')
    expect(resolveTokens('{port}', rc, 'x')).toBe('10202')
  })
  it('{service.port} 解析指定 service', () =>
    expect(resolveTokens('{backend.port}', rc, 'x')).toBe('10001'))
  it('{db.name}/{redis.db}/{minio.bucket}', () => {
    expect(resolveTokens('{db.name}', rc, 'x')).toBe('foo_2')
    expect(resolveTokens('{redis.db}', rc, 'x')).toBe('2')
    expect(resolveTokens('{minio.bucket}', rc, 'x')).toBe('foo-2')
  })
  it('{infra.postgres.*}', () => {
    expect(resolveTokens('jdbc:postgresql://{infra.postgres.host}:{infra.postgres.port}/{db.name}', rc, 'x'))
      .toBe('jdbc:postgresql://localhost:5432/foo_2')
    expect(resolveTokens('{infra.postgres.password}', rc, 'x')).toBe('sec')
  })
  it('未知 service 端口 → CONFIG_INVALID', () =>
    expect(() => resolveTokens('{nope.port}', rc, 'x')).toThrow(/CONFIG_INVALID|nope/))
  it('infra 缺项 → CONFIG_INVALID', () => {
    const rc2: ResolveContext = { self, names: { ports: {} }, infra: {} }
    expect(() => resolveTokens('{infra.postgres.host}', rc2, 'x')).toThrow(/CONFIG_INVALID|infra/)
  })
  it('无法识别的 token → CONFIG_INVALID', () =>
    expect(() => resolveTokens('{bogus.thing}', rc, 'x')).toThrow(/CONFIG_INVALID/))
})

describe('interpolateEnvs', () => {
  it('对每个值插值', () =>
    expect(interpolateEnvs({ URL: 'http://localhost:{backend.port}/api', P: '{infra.postgres.password}' }, rc))
      .toEqual({ URL: 'http://localhost:10001/api', P: 'sec' }))
  it('无 token 原样返回', () =>
    expect(interpolateEnvs({ X: 'plain', Y: '' }, rc)).toEqual({ X: 'plain', Y: '' }))
})
