// tests/providers/port.test.ts
import { describe, it, expect } from 'vitest'
import { createServer } from 'node:net'
import { createPortProvider } from '../../src/providers/port.js'
import type { Ctx } from '../../src/core/types.js'

const ctx = (): Ctx => ({
  projectRoot: '/x',
  config: {
    project_name: 'foo',
    services: [{ name: 'backend', type: 'django', port_base: 10000 }],
    infra: {},
  },
})

describe('port provider', () => {
  it('plan 产出 port_base + n', () => {
    expect(createPortProvider().plan(2, ctx()).ports).toEqual({ backend: 10002 })
  })
  it('端口空闲 probe 为 true', async () => {
    expect(await createPortProvider().probe(2, ctx())).toBe(true)
  })
  it('端口被占 probe 为 false', async () => {
    const srv = createServer().listen(10002, '127.0.0.1')
    await new Promise(r => srv.once('listening', r))
    try { expect(await createPortProvider().probe(2, ctx())).toBe(false) }
    finally { srv.close() }
  })
})
