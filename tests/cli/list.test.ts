import { describe, it, expect } from 'vitest'
import { renderList } from '../../src/cli/commands/list.js'
import type { StateFile } from '../../src/state/schema.js'

const state: StateFile = { project_name: 'foo', config_fingerprint: '', sets: {
  '1': { status: 'allocated', owner: { worktree: '/wt/foo.x', branch: 'x' },
    resources: { backend: { port: 10001 }, postgres: { database: 'foo_1' }, minio: { bucket: 'foo-1' } }, created_at: 'x' },
  '3': { status: 'free', owner: null,
    resources: { backend: { port: 10003 }, postgres: { database: 'foo_3' } }, created_at: 'x' },
}}

const multi: StateFile = { project_name: 'foo', config_fingerprint: '', sets: {
  '1': { status: 'allocated', owner: { worktree: '/wt/foo.a', branch: 'a' },
    resources: { backend: { port: 10001 } }, created_at: 'x' },
  '2': { status: 'allocated', owner: { worktree: '/wt/foo.b', branch: 'b' },
    resources: { backend: { port: 10002 } }, created_at: 'x' },
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

  it('当前目录命中某 worktree 时，置顶并标识', () => {
    const out = renderList(multi, 'foo', '/wt/foo.b')
    expect(out).toMatch(/foo\.b.*← 当前目录/)
    expect(out.indexOf('foo.b')).toBeLessThan(out.indexOf('foo.a'))
  })

  it('当前目录是 worktree 子目录时也命中', () => {
    const out = renderList(multi, 'foo', '/wt/foo.b/backend/sub')
    expect(out).toMatch(/foo\.b.*← 当前目录/)
    expect(out.indexOf('foo.b')).toBeLessThan(out.indexOf('foo.a'))
  })

  it('当前目录不在任何 worktree 时，无标识、保持原序', () => {
    const out = renderList(multi, 'foo', '/somewhere/else')
    expect(out).not.toContain('← 当前目录')
    expect(out.indexOf('foo.a')).toBeLessThan(out.indexOf('foo.b'))
  })
})
