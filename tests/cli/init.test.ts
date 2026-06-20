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
})
