// src/cli/commands/worktree.ts
import type { Command } from 'commander'
import { dirname, join, resolve } from 'node:path'
import type { Ctx } from '../../core/types.js'
import { addWorktree, removeWorktree, worktreeDirName } from '../../git/worktree.js'
import { doAllocate } from './allocate.js'
import { withState } from '../../state/store.js'
import { findSetByWorktree, deallocateInState } from '../../core/deallocator.js'
import { removeEnvBlock } from '../../inject/env.js'
import { loadCtx, runCommand } from '../context.js'
import { success, info } from '../output.js'

export async function createWorktree(ctx: Ctx, branch: string, opts: { allocate: boolean }): Promise<string> {
  const dir = join(dirname(ctx.projectRoot), worktreeDirName(ctx.config.project_name, branch))
  await addWorktree(ctx.projectRoot, branch, dir)
  if (opts.allocate) await doAllocate(ctx, dir, branch)
  return dir
}

export async function deleteWorktree(ctx: Ctx, dir: string): Promise<void> {
  await withState(ctx.config.project_name, (state) => {
    const n = findSetByWorktree(state, dir)
    if (n) deallocateInState(state, n)
  })
  removeEnvBlock(join(dir, '.env'))
  await removeWorktree(ctx.projectRoot, dir)
}

export function registerWorktree(program: Command) {
  const wt = program.command('worktree').description('管理 worktree')
  wt.command('create <branch>').description('创建 worktree（默认自动分配资源）')
    .option('--no-allocate', '只建 worktree，不分配资源')
    .action((branch: string, opts: { allocate: boolean }) => runCommand(async () => {
      const ctx = loadCtx()
      const dir = await createWorktree(ctx, branch, { allocate: opts.allocate })
      success(`worktree 已创建：${dir}${opts.allocate ? '（已分配资源、写好 .env）' : ''}`)
    }))
  wt.command('delete [dir]').description('删除 worktree（默认当前目录），资源退回池子')
    .action((dir: string | undefined) => runCommand(async () => {
      const ctx = loadCtx()
      const target = dir ? resolve(dir) : process.cwd()
      await deleteWorktree(ctx, target)
      success(`worktree 已删除：${target}（资源退回池子）`)
    }))
}
