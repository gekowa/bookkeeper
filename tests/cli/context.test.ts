// tests/cli/context.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { loadCtx, maxAttempts } from '../../src/cli/context.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bk-'))
  writeFileSync(join(root, 'bk_config.yml'),
    'project_name: foo\nservices: {}\ninfra: {}\nallocation: { max_probe_attempts: 7 }\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('cli context', () => {
  it('loadCtx 组装 projectRoot + config', () => {
    const ctx = loadCtx(root)
    expect(ctx.projectRoot).toBe(root)
    expect(ctx.config.project_name).toBe('foo')
  })
  it('maxAttempts 读 config 覆盖值', () => expect(maxAttempts(loadCtx(root))).toBe(7))
})
