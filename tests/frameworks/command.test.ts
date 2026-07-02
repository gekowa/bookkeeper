import { describe, it, expect } from 'vitest'
import { adapterFor } from '../../src/frameworks/registry.js'

const D = '/x' // dir 占位

describe('defaultStartCommand（返回 {port} 模板）', () => {
  it('django', () => expect(adapterFor('django').defaultStartCommand({ name: 'b', type: 'django', port_base: 10000 }, D))
    .toBe('uv run python manage.py runserver 0.0.0.0:{port}'))
  it('fastapi 用 app', () => expect(adapterFor('fastapi').defaultStartCommand({ name: 'b', type: 'fastapi', port_base: 10000, app: 'app.main:app' }, D))
    .toBe('uv run uvicorn app.main:app --port {port}'))
  it('vite', () => expect(adapterFor('vite').defaultStartCommand({ name: 'f', type: 'vite', port_base: 10100 }, D))
    .toBe('npm run dev -- --port {port} --strictPort'))
  it('arq 用 app', () => expect(adapterFor('arq').defaultStartCommand({ name: 'w', type: 'arq', app: 'app.worker' }, D))
    .toBe('uv run arq app.worker.WorkerSettings'))
  it('celery 用 app', () => expect(adapterFor('celery').defaultStartCommand({ name: 'w', type: 'celery', app: 'app.celery' }, D))
    .toBe('uv run celery -A app.celery worker'))
  it('fastapi 缺 app → 抛 CONFIG_INVALID', () =>
    expect(() => adapterFor('fastapi').defaultStartCommand({ name: 'b', type: 'fastapi', port_base: 10000 }, D)).toThrow(/CONFIG_INVALID|app/))
  it('arq 缺 app → 抛', () =>
    expect(() => adapterFor('arq').defaultStartCommand({ name: 'w', type: 'arq' }, D)).toThrow(/CONFIG_INVALID|app/))
  it('celery 缺 app → 抛', () =>
    expect(() => adapterFor('celery').defaultStartCommand({ name: 'w', type: 'celery' }, D)).toThrow(/CONFIG_INVALID|app/))
  it('adapterFor 未知 type → 抛', () => {
    // @ts-expect-error 故意非法 type
    expect(() => adapterFor('nope')).toThrow(/未知|nope/)
  })
})

describe('defaultInjectionMode', () => {
  for (const t of ['django', 'fastapi', 'vite', 'arq', 'celery'] as const)
    it(`${t} = dotEnv`, () => expect(adapterFor(t).defaultInjectionMode).toBe('dotEnv'))
})
