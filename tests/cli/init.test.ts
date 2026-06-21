// tests/cli/init.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { buildConfigDraft } from '../../src/cli/commands/init.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proj-'))
  mkdirSync(join(dir, 'backend')); writeFileSync(join(dir, 'backend', 'manage.py'), '')
  mkdirSync(join(dir, 'frontend')); writeFileSync(join(dir, 'frontend', 'vite.config.ts'), '')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('buildConfigDraft', () => {
  it('侦测 backend=django、frontend=vite', () => {
    const yml = buildConfigDraft(dir)
    expect(yml).toContain('project_name:')
    expect(yml).toMatch(/backend:[\s\S]*type: django/)
    expect(yml).toMatch(/frontend:[\s\S]*type: vite/)
    expect(yml).toContain('port_base: 10000')
    expect(yml).toMatch(/backend:[\s\S]*dir: backend/)
    expect(yml).toMatch(/frontend:[\s\S]*dir: frontend/)
  })

  it('fastapi service 发出 # app: TODO 注释', () => {
    const apiDir = mkdtempSync(join(tmpdir(), 'proj-'))
    try {
      mkdirSync(join(apiDir, 'api'))
      writeFileSync(join(apiDir, 'api', 'pyproject.toml'), '[tool.poetry]\nname = "api"\ndependencies = ["fastapi"]\n')
      const yml = buildConfigDraft(apiDir)
      expect(yml).toMatch(/api:[\s\S]*type: fastapi/)
      expect(yml).toContain('# app: app.main:app   # TODO fastapi 入口')
    } finally {
      rmSync(apiDir, { recursive: true, force: true })
    }
  })

  it('未侦测到 service 发出 TODO 行', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'proj-'))
    try {
      const yml = buildConfigDraft(emptyDir)
      expect(yml).toContain('# TODO 未侦测到 service，请手动填写')
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('pyproject 含 arq 依赖 → 输出注释 worker stub', () => {
    const wdir = mkdtempSync(join(tmpdir(), 'proj-'))
    try {
      mkdirSync(join(wdir, 'backend'))
      writeFileSync(join(wdir, 'backend', 'pyproject.toml'),
        '[project]\ndependencies = ["fastapi>=0.100", "arq>=0.25"]\n')
      const yml = buildConfigDraft(wdir)
      expect(yml).toMatch(/backend:[\s\S]*type: fastapi/)
      expect(yml).toContain('#   type: arq')
      expect(yml).toContain('#   dir: backend')
    } finally {
      rmSync(wdir, { recursive: true, force: true })
    }
  })

  it('vite dir 有 .env.example 含 VITE_API_BASE → 写 envs（端口换占位符）', () => {
    writeFileSync(join(dir, 'frontend', '.env.example'), 'VITE_API_BASE=http://localhost:8000/api\n')
    const yml = buildConfigDraft(dir)
    expect(yml).toMatch(/frontend:[\s\S]*    envs:/)
    expect(yml).toContain('      VITE_API_BASE: http://localhost:{backend.port}/api')
  })

  it('vite dir 无 .env* → 写注释 envs stub', () => {
    const yml = buildConfigDraft(dir)
    expect(yml).toContain('    # envs:')
    expect(yml).toContain('    #   VITE_API_BASE: http://localhost:{backend.port}')
  })
})
