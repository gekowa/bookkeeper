// src/cli/commands/setup.ts
import type { Command } from 'commander'
import type { Ctx } from '../../core/types.js'
import { readState } from '../../state/store.js'
import { findSetByWorktree } from '../../core/deallocator.js'
import { activeProviders } from '../../providers/registry.js'
import { planNames } from '../../core/allocator.js'
import { buildDirEnvs } from './allocate.js'
import { runPostAllocate } from '../../hooks/postAllocate.js'
import { BkError, Codes } from '../../core/errors.js'
import { loadCtx, runCommand } from '../context.js'
import { success } from '../output.js'

export async function doSetup(ctx: Ctx, worktreeDir: string): Promise<string> {
  const state = await readState(ctx.config.project_name)
  const n = findSetByWorktree(state, worktreeDir)
  if (!n)
    throw new BkError(Codes.NOT_IN_WORKTREE, '当前 worktree 未分配资源',
      { remediation: '先运行 bk allocate' })
  const providers = activeProviders(ctx)
  const names = planNames(providers, ctx, Number(n))
  await runPostAllocate(ctx, worktreeDir, buildDirEnvs(ctx, names), Number(n))
  return n
}

export function registerSetup(program: Command) {
  program.command('setup').description('对当前 worktree 重跑所有 service 的 post_allocate 钩子')
    .action(() => runCommand(async () => {
      const ctx = loadCtx()
      const n = await doSetup(ctx, process.cwd())
      success(`Set ${n}：post_allocate 钩子已重跑`)
    }))
}
