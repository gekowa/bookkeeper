import { describe, it, expect } from 'vitest'
import { adapterFor } from '../../src/frameworks/registry.js'

describe('defaultStartCommand', () => {
  it('django', () => expect(adapterFor('django').defaultStartCommand({ name: 'b', type: 'django', port_base: 10000 }, 10002))
    .toBe('uv run python manage.py runserver 0.0.0.0:10002'))
  it('fastapi 用 app 字段', () => expect(adapterFor('fastapi').defaultStartCommand({ name: 'b', type: 'fastapi', port_base: 10000, app: 'app.main:app' }, 10002))
    .toBe('uv run uvicorn app.main:app --port 10002'))
  it('vite', () => expect(adapterFor('vite').defaultStartCommand({ name: 'f', type: 'vite', port_base: 10100 }, 10102))
    .toBe('npm run dev -- --port 10102'))
})
