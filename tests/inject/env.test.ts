// tests/inject/env.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { writeEnvBlock, removeEnvBlock } from '../../src/inject/env.js'

let dir: string, env: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bk-')); env = join(dir, '.env') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('writeEnvBlock', () => {
  it('文件不存在时新建仅含块', () => {
    writeEnvBlock(env, { BK_DB_NAME: 'foo_2' })
    const c = readFileSync(env, 'utf8')
    expect(c).toContain('# >>> bk managed >>>')
    expect(c).toContain('BK_DB_NAME=foo_2')
    expect(c).toContain('# <<< bk managed <<<')
  })
  it('保留块外用户内容、只替换块内', () => {
    writeFileSync(env, 'SECRET=keepme\n# >>> bk managed >>>\nBK_DB_NAME=old\n# <<< bk managed <<<\nTAIL=z\n')
    writeEnvBlock(env, { BK_DB_NAME: 'foo_3' })
    const c = readFileSync(env, 'utf8')
    expect(c).toContain('SECRET=keepme')
    expect(c).toContain('TAIL=z')
    expect(c).toContain('BK_DB_NAME=foo_3')
    expect(c).not.toContain('BK_DB_NAME=old')
  })
  it('removeEnvBlock 删块留其余', () => {
    writeEnvBlock(env, { BK_DB_NAME: 'foo_2' })
    writeFileSync(env, 'KEEP=1\n' + readFileSync(env, 'utf8'))
    removeEnvBlock(env)
    const c = readFileSync(env, 'utf8')
    expect(c).toContain('KEEP=1')
    expect(c).not.toContain('bk managed')
  })
})
