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
  it('service 无 port_base 视为 worker，正常加载', () => {
    write(`project_name: foo
services:
  worker:
    type: arq
    dir: backend
    app: app.worker
infra: {}
`)
    const c = loadConfig(root)
    expect(c.services[0].name).toBe('worker')
    expect(c.services[0].port_base).toBeUndefined()
    expect(c.services[0].dir).toBe('backend')
  })
  it('port_base 存在但非数字 → 抛 CONFIG_INVALID', () => {
    write(`project_name: foo
services:
  backend:
    type: django
    port_base: not-a-number
infra: {}
`)
    expect(() => loadConfig(root)).toThrow(/port_base/)
  })
  it('透传 dir 字段', () => {
    write(`project_name: foo
services:
  backend:
    type: django
    port_base: 10000
    dir: backend
infra: {}
`)
    expect(loadConfig(root).services[0].dir).toBe('backend')
  })
  it('透传 envs 字段', () => {
    write(`project_name: foo
services:
  frontend:
    type: vite
    port_base: 10100
    envs:
      VITE_API_BASE: http://localhost:{backend.port}
infra: {}
`)
    expect(loadConfig(root).services[0].envs).toEqual({ VITE_API_BASE: 'http://localhost:{backend.port}' })
  })
  it('envs 非映射（字符串/列表）→ 抛 CONFIG_INVALID', () => {
    write(`project_name: foo
services:
  frontend:
    type: vite
    port_base: 10100
    envs: oops
infra: {}
`)
    expect(() => loadConfig(root)).toThrow(/CONFIG_INVALID|envs/)
  })
  it('透传 post_allocate 标量', () => {
    write(`project_name: foo
services:
  backend:
    type: django
    port_base: 10000
    dir: backend
    post_allocate: uv run python manage.py migrate && uv run python manage.py seed
infra: {}
`)
    expect(loadConfig(root).services[0].post_allocate)
      .toBe('uv run python manage.py migrate && uv run python manage.py seed')
  })

  it('未写 post_allocate → undefined', () => {
    write(`project_name: foo
services:
  backend:
    type: django
    port_base: 10000
infra: {}
`)
    expect(loadConfig(root).services[0].post_allocate).toBeUndefined()
  })

  it('injectionMode 非法值 → CONFIG_INVALID', () => {
    const yaml = 'project_name: p\nservices:\n  api:\n    type: django\n    injectionMode: nope\n'
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'))
    try {
      writeFileSync(join(dir, 'bk_config.yml'), yaml)
      expect(() => loadConfig(dir)).toThrow(/CONFIG_INVALID|injectionMode/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('injectionMode 合法值 dotEnv / startupArgs 可解析', () => {
    const yaml = 'project_name: p\nservices:\n  a:\n    type: django\n    injectionMode: dotEnv\n  b:\n    type: springboot\n    injectionMode: startupArgs\n'
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'))
    try {
      writeFileSync(join(dir, 'bk_config.yml'), yaml)
      const cfg = loadConfig(dir)
      expect(cfg.services[0].injectionMode).toBe('dotEnv')
      expect(cfg.services[1].injectionMode).toBe('startupArgs')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
