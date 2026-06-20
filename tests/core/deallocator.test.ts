import { describe, it, expect } from 'vitest'
import { findSetByWorktree, deallocateInState } from '../../src/core/deallocator.js'
import type { StateFile } from '../../src/state/schema.js'

const state = (): StateFile => ({ project_name: 'foo', config_fingerprint: '', sets: {
  '2': { status: 'allocated', owner: { worktree: '/wt/foo.x', branch: 'x' }, resources: {}, created_at: 'x' },
}})

describe('deallocator', () => {
  it('按 worktree 反查 set', () => expect(findSetByWorktree(state(), '/wt/foo.x')).toBe('2'))
  it('找不到返回 null', () => expect(findSetByWorktree(state(), '/nope')).toBe(null))
  it('deallocateInState → free + owner null（资源留存）', () => {
    const s = state(); deallocateInState(s, '2')
    expect(s.sets['2'].status).toBe('free'); expect(s.sets['2'].owner).toBe(null)
  })
})
