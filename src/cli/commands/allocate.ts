// src/cli/commands/allocate.ts
import type { Command } from 'commander'
import { join } from 'node:path'
import type { Ctx } from '../../core/types.js'
import type { ResourceProvider } from '../../providers/types.js'
import { withState } from '../../state/store.js'
import { activeProviders } from '../../providers/registry.js'
import { resolveSet, provisionSet, buildSetRecord, collectEnv } from '../../core/allocator.js'
import { writeEnvBlock, removeEnvBlock } from '../../inject/env.js'
import { ensureGitignore } from '../../inject/gitignore.js'
import { findSetByWorktree, deallocateInState } from '../../core/deallocator.js'
import { loadCtx, maxAttempts, runCommand } from '../context.js'
import { success, info } from '../output.js'
import { fingerprint } from '../../config/fingerprint.js'

export function serviceEnvDirs(ctx: Ctx): string[] {
  return [...new Set(ctx.config.services.map(s => s.dir ?? '.'))]
}

export function writeServiceEnvs(ctx: Ctx, worktreeDir: string, vars: Record<string, string>): void {
  for (const d of serviceEnvDirs(ctx)) writeEnvBlock(join(worktreeDir, d, '.env'), vars)
}

export function removeServiceEnvs(ctx: Ctx, worktreeDir: string): void {
  for (const d of serviceEnvDirs(ctx)) removeEnvBlock(join(worktreeDir, d, '.env'))
}

export async function doAllocate(
  ctx: Ctx, worktreeDir: string, branch: string,
  providers: ResourceProvider[] = activeProviders(ctx),
): Promise<number> {
  return withState(ctx.config.project_name, async (state) => {
    state.project_name = ctx.config.project_name
    state.config_fingerprint = fingerprint(ctx.config)
    const { n, reuse } = await resolveSet(providers, ctx, state, maxAttempts(ctx))
    if (!reuse) await provisionSet(providers, ctx, n)
    try {
      state.sets[String(n)] = buildSetRecord(providers, ctx, n, { worktree: worktreeDir, branch })
      writeServiceEnvs(ctx, worktreeDir, collectEnv(providers, ctx, n))
      ensureGitignore(ctx.projectRoot, ['.env'])
      return n
    } catch (e) {
      if (!reuse) {
        for (const p of [...providers].reverse()) {
          try { await p.destroy(n, ctx) } catch { /* best-effort rollback */ }
        }
      }
      delete state.sets[String(n)]
      throw e
    }
  })
}

export function registerAllocate(program: Command) {
  program.command('allocate').description('为当前 worktree 分配一套资源')
    .action(() => runCommand(async () => {
      const ctx = loadCtx()
      const n = await doAllocate(ctx, process.cwd(), '(manual)')
      success(`已分配 Set ${n}，并写入 .env`)
    }))

  program.command('deallocate').description('当前 worktree 解绑，资源退回池子')
    .action(() => runCommand(async () => {
      const ctx = loadCtx()
      const wt = process.cwd()
      await withState(ctx.config.project_name, (state) => {
        const n = findSetByWorktree(state, wt)
        if (!n) { info('当前 worktree 未分配资源'); return }
        deallocateInState(state, n)
        removeServiceEnvs(ctx, wt)
        success(`Set ${n} 已退回池子（资源保留）`)
      })
    }))
}
