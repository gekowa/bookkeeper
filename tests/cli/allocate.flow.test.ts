// tests/cli/allocate.flow.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { doAllocate } from '../../src/cli/commands/allocate.js'
import { readState } from '../../src/state/store.js'
import type { Ctx } from '../../src/core/types.js'

let home: string, wt: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  wt = mkdtempSync(join(tmpdir(), 'wt-'))
})
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(wt, { recursive: true, force: true }); delete process.env.BK_HOME })

const ctx = (): Ctx => ({ projectRoot: wt, config: {
  project_name: 'foo',
  services: [{ name: 'backend', type: 'django', port_base: 10000 }],
  infra: {},   // 仅 port provider，无外部依赖
}})

describe('doAllocate', () => {
  it('分配号 1、写 .env 标记块、写 state 为 allocated', async () => {
    const n = await doAllocate(ctx(), wt, 'feature/x')
    expect(n).toBe(1)
    const env = readFileSync(join(wt, '.env'), 'utf8')
    expect(env).toContain('# >>> bk managed >>>')
    const s = await readState('foo')
    expect(s.sets['1'].status).toBe('allocated')
    expect(s.sets['1'].owner?.worktree).toBe(wt)
    expect((s.sets['1'].resources['backend'] as any).port).toBe(10001)
  })
})
