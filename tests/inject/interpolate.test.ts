import { describe, it, expect } from 'vitest'
import {
  interpolateEnvs, interpolateCommand, buildInterpValues, type InterpValues,
} from '../../src/inject/interpolate.js'
import type { Ctx, ResourceNames, ServiceConfig } from '../../src/core/types.js'

const v: InterpValues = { svcName: 'frontend', ports: { backend: 10001, frontend: 10101 }, infra: {} }

describe('interpolateEnvs', () => {
  it('{service.X.port} 与旧 {X.port} 别名都能解析', () => {
    expect(interpolateEnvs({ A: '{service.backend.port}', B: '{backend.port}' }, v))
      .toEqual({ A: '10001', B: '10001' })
  })
  it('{port} 取自身端口', () => {
    expect(interpolateEnvs({ P: '{port}' }, v)).toEqual({ P: '10101' })
  })
  it('多占位符 / 无占位符原样', () => {
    expect(interpolateEnvs({ X: '{backend.port}-{frontend.port}', Y: 'plain', Z: '' }, v))
      .toEqual({ X: '10001-10101', Y: 'plain', Z: '' })
  })
  it('未知服务端口 → CONFIG_INVALID', () => {
    expect(() => interpolateEnvs({ X: '{nope.port}' }, v)).toThrow(/CONFIG_INVALID|nope/)
  })
  it('{args} 用在 envs 值里 → 报错', () => {
    expect(() => interpolateEnvs({ X: '{args}' }, v)).toThrow(/CONFIG_INVALID|args/)
  })
})

describe('interpolateCommand', () => {
  it('{args} 展开为已解析 envs 的 --k=v 串', () => {
    expect(interpolateCommand('run --port {port} {args}', v, '--BK_DB_NAME=foo_2 --BK_REDIS_DB=2'))
      .toBe('run --port 10101 --BK_DB_NAME=foo_2 --BK_REDIS_DB=2')
  })
  it('{args} 为空串时原样留空', () => {
    expect(interpolateCommand('run --port {port} {args}', v, '')).toBe('run --port 10101 ')
  })
})

describe('buildInterpValues', () => {
  const ctx: Ctx = { projectRoot: '/x', config: { project_name: 'p', infra: {
    postgres: { host: 'localhost', port: 5432, username: 'postgres', password: 'pgpw' },
    redis: { host: 'localhost', port: 6379 },
    minio: { endpoint: 'localhost:9000', access_key: 'ak', secret_key: 'sk' },
  } } }
  const names: ResourceNames = { ports: { api: 10002 }, database: 'p_2', redisDb: 2, bucket: 'p-2' }
  const svc = { name: 'api', type: 'django' } as ServiceConfig

  it('合并静态 infra 与动态分配值，支持全量占位符（含密钥）', () => {
    const vals = buildInterpValues(ctx, names, svc)
    expect(interpolateCommand(
      '{infra.postgres.database}|{infra.postgres.host}|{infra.postgres.password}|{infra.redis.db}|{infra.minio.secret_key}',
      vals, '',
    )).toBe('p_2|localhost|pgpw|2|sk')
  })
  it('引用未声明 infra → CONFIG_INVALID', () => {
    const empty: Ctx = { projectRoot: '/x', config: { project_name: 'p', infra: {} } }
    const vals = buildInterpValues(empty, { ports: {} }, svc)
    expect(() => interpolateCommand('{infra.postgres.database}', vals, '')).toThrow(/CONFIG_INVALID|postgres/)
  })
  it('redis isolation=key_prefix 时 {infra.redis.db} 不可用', () => {
    const vals = buildInterpValues(ctx, { ports: {}, redisPrefix: 'p_2_' }, svc)
    expect(() => interpolateCommand('{infra.redis.db}', vals, '')).toThrow(/CONFIG_INVALID|redis/)
    expect(interpolateCommand('{infra.redis.prefix}', vals, '')).toBe('p_2_')
  })
  it('dameng: {infra.dameng.schema} 与静态字段（含密钥）', () => {
    const ctxDm: Ctx = { projectRoot: '/x', config: { project_name: 'p', infra: {
      dameng: { host: 'localhost', port: 5236, username: 'SYSDBA', password: 'dmpw' } } } }
    const vals = buildInterpValues(ctxDm, { ports: {}, dmSchema: 'P_2' }, svc)
    expect(interpolateCommand(
      '{infra.dameng.schema}|{infra.dameng.host}|{infra.dameng.port}|{infra.dameng.username}|{infra.dameng.password}',
      vals, '',
    )).toBe('P_2|localhost|5236|SYSDBA|dmpw')
  })
  it('dameng 未声明时 {infra.dameng.schema} → CONFIG_INVALID', () => {
    const empty: Ctx = { projectRoot: '/x', config: { project_name: 'p', infra: {} } }
    const vals = buildInterpValues(empty, { ports: {} }, svc)
    expect(() => interpolateCommand('{infra.dameng.schema}', vals, '')).toThrow(/CONFIG_INVALID|dameng/)
  })
})
