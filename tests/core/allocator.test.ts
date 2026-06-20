import { describe, it, expect, vi } from 'vitest'
import { resolveSet, provisionSet } from '../../src/core/allocator.js'
import { Codes } from '../../src/core/errors.js'
import { fakeProvider } from '../helpers/fakeProvider.js'
import type { Ctx } from '../../src/core/types.js'
import type { StateFile } from '../../src/state/schema.js'

const ctx = {} as Ctx
const emptyState: StateFile = { project_name: 'foo', config_fingerprint: '', sets: {} }

describe('resolveSet', () => {
  it('全部 probe 通过 → 取号 1', async () => {
    const p = [fakeProvider({ kind: 'a' })]
    expect(await resolveSet(p, ctx, emptyState, 20)).toEqual({ n: 1, reuse: false })
  })
  it('号 1 撞了 → 跳到号 2', async () => {
    const probe = vi.fn().mockImplementation(async (n: number) => n !== 1)
    const p = [fakeProvider({ kind: 'a', probe })]
    expect((await resolveSet(p, ctx, emptyState, 20)).n).toBe(2)
  })
  it('连撞超过上限 → PROBE_EXHAUSTED', async () => {
    const p = [fakeProvider({ kind: 'a', probe: async () => false })]
    await expect(resolveSet(p, ctx, emptyState, 3)).rejects.toMatchObject({ code: Codes.PROBE_EXHAUSTED })
  })
  it('碰撞跳号时不污染传入的 state（防幻影条目）', async () => {
    const state: StateFile = { project_name: 'foo', config_fingerprint: '', sets: {} }
    const probe = vi.fn().mockImplementation(async (n: number) => n !== 1) // n=1 collides, n=2 ok
    const p = [fakeProvider({ kind: 'a', probe })]
    const res = await resolveSet(p, ctx, state, 20)
    expect(res.n).toBe(2)
    expect(state.sets).toEqual({}) // caller state untouched — no phantom '1' marker
  })
})

describe('provisionSet 回滚', () => {
  it('后一个 provision 致命错 → 倒序 destroy 已成功者', async () => {
    const destroyA = vi.fn(async () => {})
    const a = fakeProvider({ kind: 'a', destroy: destroyA })
    const b = fakeProvider({ kind: 'b', provision: async () => { throw new Error('boom') } })
    await expect(provisionSet([a, b], ctx, 1)).rejects.toThrow('boom')
    expect(destroyA).toHaveBeenCalledOnce()
  })
})
