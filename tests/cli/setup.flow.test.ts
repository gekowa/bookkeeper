import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { doAllocate } from '../../src/cli/commands/allocate.js'
import { doSetup } from '../../src/cli/commands/setup.js'
import { createPortProvider } from '../../src/providers/port.js'
import { fakeProvider } from '../helpers/fakeProvider.js'
import type { Ctx } from '../../src/core/types.js'

let home: string, wt: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  wt = mkdtempSync(join(tmpdir(), 'wt-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(wt, { recursive: true, force: true })
  delete process.env.BK_HOME
})

const provs = () => [createPortProvider(), fakeProvider({ kind: 'pg', plan: () => ({ database: 'foo_1' }) })]
const ctx = (): Ctx => ({ projectRoot: wt, config: { project_name: 'foo', infra: {},
  services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend',
    post_allocate: 'echo "$BK_N" > hook.txt' }] } })

describe('doSetup', () => {
  it('未分配的 worktree → 抛 NOT_IN_WORKTREE', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'bare-'))
    await expect(doSetup(ctx(), bare)).rejects.toMatchObject({ code: 'NOT_IN_WORKTREE' })
    rmSync(bare, { recursive: true, force: true })
  })

  it('已分配 → 重跑 post_allocate（注入 BK_N）', async () => {
    mkdirSync(join(wt, 'backend'))
    const c = ctx()
    await doAllocate(c, wt, 'feature/x', provs(), { hook: false })  // 先建好 Set，不跑钩子
    const n = await doSetup(c, wt)
    expect(n).toBe('1')
    expect(readFileSync(join(wt, 'backend', 'hook.txt'), 'utf8').trim()).toBe('1')
  })
})
