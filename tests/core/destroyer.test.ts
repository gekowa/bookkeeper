import { describe, it, expect, vi } from 'vitest'
import { destroySet } from '../../src/core/destroyer.js'
import { fakeProvider } from '../helpers/fakeProvider.js'
import type { StateFile } from '../../src/state/schema.js'
import type { Ctx } from '../../src/core/types.js'
import { Codes } from '../../src/core/errors.js'

const ctx = {} as Ctx
const mk = (status: 'allocated' | 'free'): StateFile => ({ project_name: 'foo', config_fingerprint: '', sets: {
  '2': { status, owner: status === 'allocated' ? { worktree: '/w', branch: 'x' } : null, resources: {}, created_at: 'x' },
}})

describe('destroySet', () => {
  it('占用中且非 force → SET_IN_USE，不删', async () => {
    const s = mk('allocated')
    await expect(destroySet([fakeProvider({ kind: 'a' })], ctx, s, 2, { force: false }))
      .rejects.toMatchObject({ code: Codes.SET_IN_USE })
    expect(s.sets['2']).toBeDefined()
  })
  it('force 时即便占用也销毁、调 provider.destroy、删条目', async () => {
    const destroy = vi.fn(async () => {})
    const s = mk('allocated')
    await destroySet([fakeProvider({ kind: 'a', destroy })], ctx, s, 2, { force: true })
    expect(destroy).toHaveBeenCalledWith(2, ctx)
    expect(s.sets['2']).toBeUndefined()
  })
  it('free 资源直接销毁', async () => {
    const s = mk('free')
    await destroySet([fakeProvider({ kind: 'a' })], ctx, s, 2, { force: false })
    expect(s.sets['2']).toBeUndefined()
  })
})
