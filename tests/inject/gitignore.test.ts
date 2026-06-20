// tests/inject/gitignore.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { ensureGitignore } from '../../src/inject/gitignore.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bk-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ensureGitignore', () => {
  it('新建并追加；重复调用幂等', () => {
    ensureGitignore(dir, ['.env'])
    ensureGitignore(dir, ['.env'])
    const lines = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n').filter(Boolean)
    expect(lines.filter(l => l === '.env')).toHaveLength(1)
  })
  it('保留已有内容', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
    ensureGitignore(dir, ['.env'])
    const c = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(c).toContain('node_modules/'); expect(c).toContain('.env')
  })
})
