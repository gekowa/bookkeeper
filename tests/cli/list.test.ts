import { describe, it, expect } from 'vitest'
import { renderList } from '../../src/cli/commands/list.js'
import type { StateFile } from '../../src/state/schema.js'

const state: StateFile = { project_name: 'foo', config_fingerprint: '', sets: {
  '1': { status: 'allocated', owner: { worktree: '/wt/foo.x', branch: 'x' },
    resources: { backend: { port: 10001 }, postgres: { database: 'foo_1' }, minio: { bucket: 'foo-1' } }, created_at: 'x' },
  '3': { status: 'free', owner: null,
    resources: { backend: { port: 10003 }, postgres: { database: 'foo_3' } }, created_at: 'x' },
}}

describe('renderList', () => {
  it('含 allocated worktree、free 池、下一个号', () => {
    const out = renderList(state, 'foo')
    expect(out).toContain('foo.x')
    expect(out).toContain('foo_1')
    expect(out).toContain('Unallocated')
    expect(out).toContain('Set 3')
    expect(out).toMatch(/Next free number:\s*2/)
  })
})
