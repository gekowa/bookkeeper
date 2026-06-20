import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/config/load.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bk-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

function write(yml: string) { writeFileSync(join(root, 'bk_config.yml'), yml) }

describe('loadConfig', () => {
  it('解析并归一化 services 为带 name 的数组', () => {
    write(`project_name: foo
services:
  backend:
    type: django
    port_base: 10000
  frontend:
    type: vite
    port_base: 10100
infra:
  postgres: { host: localhost, port: 5432, username: postgres, password: postgres }
  redis: { host: localhost, port: 6379, isolation: key_prefix }
  minio: { endpoint: localhost:9000, access_key: a, secret_key: b }
`)
    const c = loadConfig(root)
    expect(c.project_name).toBe('foo')
    expect(c.services.map(s => s.name)).toEqual(['backend', 'frontend'])
    expect(c.services[0].type).toBe('django')
    expect(c.infra.redis?.isolation).toBe('key_prefix')
  })
  it('缺 project_name 抛 CONFIG_INVALID', () => {
    write(`services: {}\n`)
    expect(() => loadConfig(root)).toThrow(/project_name/)
  })
  it('service 缺 type 抛 CONFIG_INVALID', () => {
    write(`project_name: foo
services:
  backend:
    port_base: 10000
infra: {}
`)
    expect(() => loadConfig(root)).toThrow(/type/)
  })
  it('service 缺 port_base 抛 CONFIG_INVALID', () => {
    write(`project_name: foo
services:
  backend:
    type: django
infra: {}
`)
    expect(() => loadConfig(root)).toThrow(/port_base/)
  })
})
