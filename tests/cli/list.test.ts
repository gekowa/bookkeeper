import { describe, it, expect } from 'vitest'
import { renderList } from '../../src/cli/commands/list.js'
import type { StateFile } from '../../src/state/schema.js'
import type { ProjectConfig } from '../../src/core/types.js'

const config: ProjectConfig = {
  project_name: 'foo',
  services: [{ name: 'backend', type: 'django' }],
  infra: {
    postgres: { host: 'h', port: 5432, username: 'u', password: 'p' },
    minio: { endpoint: 'e', access_key: 'a', secret_key: 's' },
    dameng: { host: '127.0.0.1', port: 5236, username: 'SYSDBA', password: 'p' },
  },
}

const state: StateFile = { project_name: 'foo', config_fingerprint: '', sets: {
  '1': { status: 'allocated', owner: { worktree: '/wt/foo.x', branch: 'x' },
    resources: { backend: { port: 10001 }, postgres: { database: 'foo_1' }, minio: { bucket: 'foo-1' }, dameng: { schema: 'FOO_1' } }, created_at: 'x' },
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
    const out = renderList(state, 'foo', config)
    expect(out).toContain('foo.x')
    expect(out).toContain('foo_1')
    expect(out).toContain('Unallocated')
    expect(out).toContain('Set 3')
    expect(out).toMatch(/Next free number:\s*2/)
  })

  it('当前目录命中某 worktree 时，置顶并标识', () => {
    const out = renderList(multi, 'foo', config, '/wt/foo.b')
    expect(out).toMatch(/foo\.b.*← 当前目录/)
    expect(out.indexOf('foo.b')).toBeLessThan(out.indexOf('foo.a'))
  })

  it('当前目录是 worktree 子目录时也命中', () => {
    const out = renderList(multi, 'foo', config, '/wt/foo.b/backend/sub')
    expect(out).toMatch(/foo\.b.*← 当前目录/)
    expect(out.indexOf('foo.b')).toBeLessThan(out.indexOf('foo.a'))
  })

  it('当前目录不在任何 worktree 时，无标识、保持原序', () => {
    const out = renderList(multi, 'foo', config, '/somewhere/else')
    expect(out).not.toContain('← 当前目录')
    expect(out.indexOf('foo.a')).toBeLessThan(out.indexOf('foo.b'))
  })

  it('infra 不含 minio 时，不显示 MinIO（即使已持久化）', () => {
    const noMinio: ProjectConfig = { ...config, infra: { postgres: config.infra.postgres } }
    const out = renderList(state, 'foo', noMinio)
    expect(out).not.toContain('MinIO bucket')
    expect(out).toContain('foo_1') // postgres 仍在配置中，照常显示
  })

  it('services 不含某服务名时，不显示该端口行', () => {
    const noBackend: ProjectConfig = { ...config, services: [] }
    const out = renderList(state, 'foo', noBackend)
    expect(out).not.toMatch(/- backend 10001/)
  })

  it('infra 不含 postgres 时，不显示 PostgreSQL 行', () => {
    const noPg: ProjectConfig = { ...config, infra: { minio: config.infra.minio } }
    const out = renderList(state, 'foo', noPg)
    expect(out).not.toContain('PostgreSQL:')
  })

  it('含 dameng infra 时显示「达梦 schema」行', () => {
    const out = renderList(state, 'foo', config)
    expect(out).toContain('达梦 schema: FOO_1')
  })
  it('infra 不含 dameng 时，不显示达梦行（即使已持久化）', () => {
    const noDm: ProjectConfig = { ...config, infra: { postgres: config.infra.postgres } }
    const out = renderList(state, 'foo', noDm)
    expect(out).not.toContain('达梦 schema')
  })
})
