import { describe, it, expect } from 'vitest'
import { adapterFor, injectionModeFor } from '../../src/frameworks/registry.js'
import type { ResolveContext, ServiceConfig } from '../../src/core/types.js'

const rc = (svc: ServiceConfig, ports: Record<string, number>): ResolveContext =>
  ({ self: svc, names: { ports }, infra: {} })

describe('defaultStartCommand', () => {
  it('django', () => {
    const s: ServiceConfig = { name: 'b', type: 'django', port_base: 10000 }
    expect(adapterFor('django').defaultStartCommand(s, rc(s, { b: 10002 })))
      .toBe('uv run python manage.py runserver 0.0.0.0:10002')
  })
  it('fastapi 用 app 字段', () => {
    const s: ServiceConfig = { name: 'b', type: 'fastapi', port_base: 10000, app: 'app.main:app' }
    expect(adapterFor('fastapi').defaultStartCommand(s, rc(s, { b: 10002 })))
      .toBe('uv run uvicorn app.main:app --port 10002')
  })
  it('vite', () => {
    const s: ServiceConfig = { name: 'f', type: 'vite', port_base: 10100 }
    expect(adapterFor('vite').defaultStartCommand(s, rc(s, { f: 10102 })))
      .toBe('npm run dev -- --port 10102 --strictPort')
  })
  it('arq 用 app 字段', () => {
    const s: ServiceConfig = { name: 'w', type: 'arq', app: 'app.worker' }
    expect(adapterFor('arq').defaultStartCommand(s, rc(s, {}))).toBe('uv run arq app.worker.WorkerSettings')
  })
  it('celery 用 app 字段', () => {
    const s: ServiceConfig = { name: 'w', type: 'celery', app: 'app.celery' }
    expect(adapterFor('celery').defaultStartCommand(s, rc(s, {}))).toBe('uv run celery -A app.celery worker')
  })
  it('fastapi 缺 app → CONFIG_INVALID', () => {
    const s: ServiceConfig = { name: 'b', type: 'fastapi', port_base: 10000 }
    expect(() => adapterFor('fastapi').defaultStartCommand(s, rc(s, { b: 10002 }))).toThrow(/CONFIG_INVALID|app/)
  })
  it('django 缺端口 → CONFIG_INVALID', () => {
    const s: ServiceConfig = { name: 'b', type: 'django' }
    expect(() => adapterFor('django').defaultStartCommand(s, rc(s, {}))).toThrow(/CONFIG_INVALID|端口|port/)
  })
  it('vite 缺端口 → CONFIG_INVALID', () => {
    const s: ServiceConfig = { name: 'f', type: 'vite' }
    expect(() => adapterFor('vite').defaultStartCommand(s, rc(s, {}))).toThrow(/CONFIG_INVALID|端口|port/)
  })
})

describe('injectionModeFor', () => {
  it('缺省按 type 推导', () => {
    expect(injectionModeFor({ name: 'b', type: 'django' })).toBe('dotEnv')
    expect(injectionModeFor({ name: 'f', type: 'vite' })).toBe('dotEnv')
  })
  it('显式覆盖', () =>
    expect(injectionModeFor({ name: 'b', type: 'django', injectionMode: 'startupArgs' })).toBe('startupArgs'))
})
