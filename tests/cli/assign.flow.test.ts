// tests/cli/assign.flow.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { doAssign, parseSetNumber } from '../../src/cli/commands/assign.js'
import { doAllocate } from '../../src/cli/commands/allocate.js'
import { readState, withState } from '../../src/state/store.js'
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

const ctx = (): Ctx => ({ projectRoot: wt, config: {
  project_name: 'foo',
  services: [{ name: 'backend', type: 'django', port_base: 10000 }],
  infra: {},
}})

// 使用纯 fake provider，避免依赖真实端口探活（保证 n 从 1 开始确定性地递增）
// database 名跟随 n，模拟"同一 N 推导同名"
const provs = () => [
  fakeProvider({ kind: 'port', plan: (n: number, ctx: any) => ({ ports: Object.fromEntries((ctx.config.services ?? []).filter((s: any) => s.port_base !== undefined).map((s: any) => [s.name, s.port_base + n])) }) }),
  fakeProvider({ kind: 'pg', plan: (n: number) => ({ database: `foo_${n}` }) }),
]

async function seedFreeSet(n: number) {
  await withState('foo', (s) => {
    s.project_name = 'foo'
    s.sets[String(n)] = { status: 'free', owner: null, resources: {}, created_at: '2026-01-01T00:00:00.000Z' }
  })
}
async function seedAllocatedTo(n: number, worktree: string) {
  await withState('foo', (s) => {
    s.project_name = 'foo'
    s.sets[String(n)] = { status: 'allocated', owner: { worktree, branch: '(seed)' }, resources: {}, created_at: '2026-01-01T00:00:00.000Z' }
  })
}

describe('parseSetNumber', () => {
  it('接受 ≥1 整数', () => { expect(parseSetNumber('3')).toBe(3) })
  it('拒绝 0 / 负数 / 非数字 / 小数', () => {
    for (const bad of ['0', '-1', 'abc', '2.5', '']) expect(() => parseSetNumber(bad)).toThrow()
  })
})

describe('doAssign', () => {
  it('free + 当前未分配 → 绑定、写 .env、state 翻 allocated 且 owner=cwd', async () => {
    await seedFreeSet(3)
    const res = await doAssign(ctx(), 3, wt, provs())
    expect(res.reused).toBe(false)
    expect(res.n).toBe(3)
    const env = readFileSync(join(wt, '.env'), 'utf8')
    expect(env).toContain('# >>> bk managed >>>')
    expect(env).toContain('BK_DB_NAME=foo_3')
    const s = await readState('foo')
    expect(s.sets['3'].status).toBe('allocated')
    expect(s.sets['3'].owner?.worktree).toBe(wt)
    expect(s.sets['3'].owner?.branch).toBe('(manual)')
  })

  it('N 不存在 → SET_NOT_FOUND，state 不变、无 .env', async () => {
    await expect(doAssign(ctx(), 9, wt, provs())).rejects.toMatchObject({ code: 'SET_NOT_FOUND' })
    expect(existsSync(join(wt, '.env'))).toBe(false)
    const s = await readState('foo')
    expect(s.sets['9']).toBeUndefined()
  })

  it('已绑 N（幂等）→ reused、不重写 .env、不新增 set', async () => {
    await doAllocate(ctx(), wt, '(manual)', provs())  // 当前 cwd 绑到 set 1
    const env1 = readFileSync(join(wt, '.env'), 'utf8')
    const res = await doAssign(ctx(), 1, wt, provs())
    expect(res.reused).toBe(true)
    expect(res.n).toBe(1)
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe(env1)  // .env 未被覆盖
    const s = await readState('foo')
    expect(Object.keys(s.sets)).toHaveLength(1)
  })

  it('N 被别的 worktree 占用 → SET_IN_USE（force 也抛）', async () => {
    await seedAllocatedTo(5, '/somewhere/else')
    await expect(doAssign(ctx(), 5, wt, provs())).rejects.toMatchObject({ code: 'SET_IN_USE' })
    await expect(doAssign(ctx(), 5, wt, provs(), { force: true })).rejects.toMatchObject({ code: 'SET_IN_USE' })
    const s = await readState('foo')
    expect(s.sets['5'].owner?.worktree).toBe('/somewhere/else')  // 未被夺走
  })

  it('当前已绑 M、N 为 free、无 force → ALREADY_ALLOCATED，M/N 状态都不变', async () => {
    await doAllocate(ctx(), wt, '(manual)', provs())  // cwd 绑到 set 1
    await seedFreeSet(2)
    await expect(doAssign(ctx(), 2, wt, provs())).rejects.toMatchObject({ code: 'ALREADY_ALLOCATED' })
    const s = await readState('foo')
    expect(s.sets['1'].status).toBe('allocated')
    expect(s.sets['1'].owner?.worktree).toBe(wt)
    expect(s.sets['2'].status).toBe('free')
  })

  it('当前已绑 M、N 为 free、--force → M 退回池子、N 绑到 cwd、.env 重写', async () => {
    await doAllocate(ctx(), wt, '(manual)', provs())  // cwd 绑到 set 1
    await seedFreeSet(2)
    const res = await doAssign(ctx(), 2, wt, provs(), { force: true })
    expect(res.reused).toBe(false)
    expect(res.repointedFrom).toBe(1)
    const s = await readState('foo')
    expect(s.sets['1'].status).toBe('free')
    expect(s.sets['1'].owner).toBeNull()
    expect(s.sets['2'].status).toBe('allocated')
    expect(s.sets['2'].owner?.worktree).toBe(wt)
    expect(readFileSync(join(wt, '.env'), 'utf8')).toContain('BK_DB_NAME=foo_2')  // 指向新号
  })
})

describe('doAssign 钩子时序', () => {
  const hookCtx = (): Ctx => ({ projectRoot: wt, config: {
    project_name: 'foo', infra: {},
    services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend',
      post_allocate: 'echo "$BK_N" >> hook.txt' }],
  }})

  it('绑定成功 → 跑钩子（注入 BK_N）', async () => {
    mkdirSync(join(wt, 'backend'))
    await seedFreeSet(3)
    await doAssign(hookCtx(), 3, wt, provs())
    expect(readFileSync(join(wt, 'backend', 'hook.txt'), 'utf8').trim()).toBe('3')
  })

  it('幂等命中 → 不跑钩子', async () => {
    mkdirSync(join(wt, 'backend'))
    await doAllocate(hookCtx(), wt, '(manual)', provs())  // 跑一次钩子，hook.txt = "1"
    await doAssign(hookCtx(), 1, wt, provs())             // reused：不应再追加
    const lines = readFileSync(join(wt, 'backend', 'hook.txt'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
  })

  it('--no-hook → 即便绑定也不跑钩子', async () => {
    mkdirSync(join(wt, 'backend'))
    await seedFreeSet(3)
    await doAssign(hookCtx(), 3, wt, provs(), { hook: false })
    expect(existsSync(join(wt, 'backend', 'hook.txt'))).toBe(false)
  })
})
