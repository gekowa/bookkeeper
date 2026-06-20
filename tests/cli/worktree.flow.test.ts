// tests/cli/worktree.flow.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join, dirname } from 'node:path'
import { createWorktree, deleteWorktree } from '../../src/cli/commands/worktree.js'
import { readState } from '../../src/state/store.js'
import type { Ctx } from '../../src/core/types.js'

let home: string, repo: string
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  repo = mkdtempSync(join(tmpdir(), 'foo-'))     // 充当 main 仓库（名字无关，project_name 来自 config）
  await execa('git', ['-C', repo, 'init', '-b', 'main'])
  await execa('git', ['-C', repo, 'config', 'user.email', 't@t.io'])
  await execa('git', ['-C', repo, 'config', 'user.name', 't'])
  writeFileSync(join(repo, 'f'), 'x')
  await execa('git', ['-C', repo, 'add', '.']); await execa('git', ['-C', repo, 'commit', '-m', 'i'])
})
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.BK_HOME
  rmSync(repo, { recursive: true, force: true }) })

const ctx = (): Ctx => ({ projectRoot: repo, config: {
  project_name: 'foo', services: [{ name: 'backend', type: 'django', port_base: 10000 }], infra: {} }})

describe('worktree create/delete', () => {
  it('create 建目录 ../foo.feature-x、分配资源', async () => {
    const dir = await createWorktree(ctx(), 'feature/x', { allocate: true })
    expect(dir).toBe(join(dirname(repo), 'foo.feature-x'))
    expect(existsSync(dir)).toBe(true)
    const s = await readState('foo')
    expect(Object.values(s.sets)[0].owner?.worktree).toBe(dir)
  })
  it('delete 退回池子并移除 worktree', async () => {
    const dir = await createWorktree(ctx(), 'feature/y', { allocate: true })
    await deleteWorktree(ctx(), dir)
    expect(existsSync(dir)).toBe(false)
    const s = await readState('foo')
    expect(Object.values(s.sets)[0].status).toBe('free')
  })
})
