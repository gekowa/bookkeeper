import { describe, it, expect } from 'vitest'
import { fingerprint } from '../../src/config/fingerprint.js'
import type { ProjectConfig } from '../../src/core/types.js'

const base: ProjectConfig = {
  project_name: 'testproj',
  services: [{ name: 'backend', type: 'django', port_base: 10000 }],
  infra: {
    postgres: { host: 'localhost', port: 5432, username: 'postgres', password: 'postgres' },
    redis: { host: 'localhost', port: 6379, isolation: 'key_prefix' },
  },
}

describe('fingerprint', () => {
  it('返回以 sha256: 开头的字符串', () => {
    expect(fingerprint(base)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('STABLE: 同一配置两次哈希相同', () => {
    expect(fingerprint(base)).toBe(fingerprint(base))
  })

  it('STABLE: key 顺序不同的浅克隆哈希相同', () => {
    const reordered: ProjectConfig = {
      infra: base.infra,
      services: base.services,
      project_name: base.project_name,
    }
    expect(fingerprint(base)).toBe(fingerprint(reordered))
  })

  it('REGRESSION: 嵌套 service port_base 不同则哈希不同', () => {
    const configA: ProjectConfig = {
      ...base,
      services: [{ name: 'backend', type: 'django', port_base: 10000 }],
    }
    const configB: ProjectConfig = {
      ...base,
      services: [{ name: 'backend', type: 'django', port_base: 10001 }],
    }
    expect(fingerprint(configA)).not.toBe(fingerprint(configB))
  })
})
