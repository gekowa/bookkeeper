import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeBranch, worktreeDirName, addWorktree, removeWorktree } from '../../src/git/worktree.js'

describe('naming', () => {
  it('sanitizeBranch 把 / 换成 -', () => expect(sanitizeBranch('feature/login')).toBe('feature-login'))
  it('worktreeDirName 组合 project.branch', () =>
    expect(worktreeDirName('foo', 'feature/login')).toBe('foo.feature-login'))
})

describe('add/remove worktree（真 git）', () => {
  let repo: string
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'bkrepo-'))
    await execa('git', ['-C', repo, 'init', '-b', 'main'])
    await execa('git', ['-C', repo, 'config', 'user.email', 't@t.io'])
    await execa('git', ['-C', repo, 'config', 'user.name', 't'])
    writeFileSync(join(repo, 'f.txt'), 'x')
    await execa('git', ['-C', repo, 'add', '.'])
    await execa('git', ['-C', repo, 'commit', '-m', 'init'])
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('创建并删除 worktree', async () => {
    const dir = join(repo, '..', worktreeDirName('foo', 'feature/x'))
    await addWorktree(repo, 'feature/x', dir)
    expect(existsSync(dir)).toBe(true)
    await removeWorktree(repo, dir)
    expect(existsSync(dir)).toBe(false)
  })
})
