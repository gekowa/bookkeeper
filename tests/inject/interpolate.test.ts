import { describe, it, expect } from 'vitest'
import { interpolateEnvs } from '../../src/inject/interpolate.js'
import type { ResourceNames } from '../../src/core/types.js'

const names: ResourceNames = { ports: { backend: 10001, frontend: 10101 } }

describe('interpolateEnvs', () => {
  it('替换 {service.port}', () => {
    expect(interpolateEnvs({ VITE_API_BASE: 'http://localhost:{backend.port}/api' }, names, 'frontend'))
      .toEqual({ VITE_API_BASE: 'http://localhost:10001/api' })
  })
  it('一个值里多个占位符', () => {
    expect(interpolateEnvs({ X: '{backend.port}-{frontend.port}' }, names, 'frontend'))
      .toEqual({ X: '10001-10101' })
  })
  it('未知服务名 → CONFIG_INVALID', () => {
    expect(() => interpolateEnvs({ X: '{nope.port}' }, names, 'frontend')).toThrow(/CONFIG_INVALID|nope/)
  })
  it('无占位符原样返回', () => {
    expect(interpolateEnvs({ X: 'plain', Y: '' }, names, 'frontend')).toEqual({ X: 'plain', Y: '' })
  })
})
