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
})
