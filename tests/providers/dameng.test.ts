import { describe, it, expect } from 'vitest'
import { createDamengProvider } from '../../src/providers/dameng.js'
import type { Ctx } from '../../src/core/types.js'

const ctx: Ctx = {
  projectRoot: '/x',
  config: { project_name: 'foo', services: [],
    infra: { dameng: { host: '127.0.0.1', port: 5236, username: 'SYSDBA', password: 'x' } } },
}

describe('dameng provider plan', () => {
  it('产大写 schema 名 <PROJECT>_N', () => {
    const p = createDamengProvider()
    expect(p.plan(1, ctx).dmSchema).toBe('FOO_1')
    expect(p.plan(12, ctx).dmSchema).toBe('FOO_12')
  })
  it('kind = dameng', () => {
    expect(createDamengProvider().kind).toBe('dameng')
  })
})

describe('dameng provider cfg guard', () => {
  it('infra 无 dameng 时 probe 抛 CONFIG_INVALID', async () => {
    const ctxNoDm: Ctx = { projectRoot: '/x', config: { project_name: 'foo', services: [], infra: {} } }
    await expect(createDamengProvider().probe(1, ctxNoDm)).rejects.toThrow(/CONFIG_INVALID|dameng/)
  })
})
