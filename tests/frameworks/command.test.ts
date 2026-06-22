import { describe, it, expect } from 'vitest'
import { adapterFor } from '../../src/frameworks/registry.js'

describe('defaultStartCommand', () => {
  it('django', () => expect(adapterFor('django').defaultStartCommand({ name: 'b', type: 'django', port_base: 10000 }, 10002))
    .toBe('uv run python manage.py runserver 0.0.0.0:10002'))
  it('fastapi 用 app 字段', () => expect(adapterFor('fastapi').defaultStartCommand({ name: 'b', type: 'fastapi', port_base: 10000, app: 'app.main:app' }, 10002))
    .toBe('uv run uvicorn app.main:app --port 10002'))
  it('vite', () => expect(adapterFor('vite').defaultStartCommand({ name: 'f', type: 'vite', port_base: 10100 }, 10102))
    .toBe('npm run dev -- --port 10102 --strictPort'))
  it('fastapi 缺 app 字段 → 抛 CONFIG_INVALID', () => {
    expect(() => adapterFor('fastapi').defaultStartCommand({ name: 'b', type: 'fastapi', port_base: 10000 }, 10002))
      .toThrow(/CONFIG_INVALID|app/)
  })
  it('django 缺端口 → 抛 CONFIG_INVALID', () => {
    expect(() => adapterFor('django').defaultStartCommand({ name: 'b', type: 'django' }))
      .toThrow(/CONFIG_INVALID|端口|port/)
  })
  it('vite 缺端口 → 抛 CONFIG_INVALID', () => {
    expect(() => adapterFor('vite').defaultStartCommand({ name: 'f', type: 'vite' }))
      .toThrow(/CONFIG_INVALID|端口|port/)
  })
  it('adapterFor 未知 type → 抛错', () => {
    // @ts-expect-error 故意传入非法 type 验证运行时防御
    expect(() => adapterFor('nope')).toThrow(/未知|nope/)
  })
  it('arq 用 app 字段', () => expect(adapterFor('arq').defaultStartCommand({ name: 'w', type: 'arq', app: 'app.worker' }))
    .toBe('uv run arq app.worker.WorkerSettings'))
  it('celery 用 app 字段', () => expect(adapterFor('celery').defaultStartCommand({ name: 'w', type: 'celery', app: 'app.celery' }))
    .toBe('uv run celery -A app.celery worker'))
  it('arq 缺 app → 抛 CONFIG_INVALID', () => {
    expect(() => adapterFor('arq').defaultStartCommand({ name: 'w', type: 'arq' })).toThrow(/CONFIG_INVALID|app/)
  })
  it('celery 缺 app → 抛 CONFIG_INVALID', () => {
    expect(() => adapterFor('celery').defaultStartCommand({ name: 'w', type: 'celery' })).toThrow(/CONFIG_INVALID|app/)
  })
})
