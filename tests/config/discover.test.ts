import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverProjectRoot } from '../../src/config/discover.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bk-'))
  writeFileSync(join(root, 'bk_config.yml'), 'project_name: foo\n')
  mkdirSync(join(root, 'a', 'b'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('discoverProjectRoot', () => {
  it('从深层子目录向上找到根', () => {
    expect(discoverProjectRoot(join(root, 'a', 'b'))).toBe(root)
  })
  it('找不到时抛错', () => {
    expect(() => discoverProjectRoot(tmpdir())).toThrow(/bk_config\.yml/)
  })
})
