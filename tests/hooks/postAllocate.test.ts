import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { runPostAllocate } from '../../src/hooks/postAllocate.js'
import type { Ctx } from '../../src/core/types.js'

let wt: string
beforeEach(() => { wt = mkdtempSync(join(tmpdir(), 'wt-')) })
afterEach(() => rmSync(wt, { recursive: true, force: true }))

const ctx = (services: any[]): Ctx =>
  ({ projectRoot: wt, config: { project_name: 'foo', services, infra: {} } })

describe('runPostAllocate', () => {
  it('在 service 的 dir 下运行、注入 BK_N 与该目录的 BK_*', async () => {
    mkdirSync(join(wt, 'backend'))
    const c = ctx([{ name: 'backend', type: 'django', dir: 'backend',
      post_allocate: 'echo "$BK_N-$BK_DB_NAME" > out.txt' }])
    const dirEnvs = new Map([['backend', { BK_DB_NAME: 'foo_2' }]])
    await runPostAllocate(c, wt, dirEnvs, 2)
    expect(readFileSync(join(wt, 'backend', 'out.txt'), 'utf8').trim()).toBe('2-foo_2')
  })

  it('跳过没有 post_allocate 的 service', async () => {
    const c = ctx([{ name: 'frontend', type: 'vite', dir: '.' }])
    await expect(runPostAllocate(c, wt, new Map(), 1)).resolves.toBeUndefined()
  })

  it('fail-fast：第一个 service 失败抛 HOOK_FAILED 且不跑后续', async () => {
    const c = ctx([
      { name: 'a', type: 'django', dir: '.', post_allocate: 'exit 3' },
      { name: 'b', type: 'vite', dir: '.', post_allocate: 'echo hi > b.txt' },
    ])
    await expect(runPostAllocate(c, wt, new Map(), 1))
      .rejects.toMatchObject({ code: 'HOOK_FAILED' })
    expect(existsSync(join(wt, 'b.txt'))).toBe(false)
  })
})
