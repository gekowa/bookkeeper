// src/cli/commands/allocate.ts
import type { Command } from 'commander'
import { join } from 'node:path'
import type { Ctx, ResourceNames, SetRecord } from '../../core/types.js'
import type { ResourceProvider } from '../../providers/types.js'
import { withState } from '../../state/store.js'
import { activeProviders } from '../../providers/registry.js'
import { resolveSet, provisionSet, buildSetRecord, planNames } from '../../core/allocator.js'
import { writeEnvBlock, removeEnvBlock } from '../../inject/env.js'
import { interpolateEnvs } from '../../inject/interpolate.js'
import { adapterFor } from '../../frameworks/registry.js'
import { ensureGitignore } from '../../inject/gitignore.js'
import { findSetByWorktree, deallocateInState } from '../../core/deallocator.js'
import { loadCtx, maxAttempts, runCommand } from '../context.js'
import { success, info, plain } from '../output.js'
import { renderSet } from './list.js'
import { fingerprint } from '../../config/fingerprint.js'
import { runPostAllocate } from '../../hooks/postAllocate.js'

export function serviceEnvDirs(ctx: Ctx): string[] {
  return [...new Set(ctx.config.services.map(s => s.dir ?? '.'))]
}

export function buildDirEnvs(ctx: Ctx, names: ResourceNames): Map<string, Record<string, string>> {
  const byDir = new Map<string, Record<string, string>>()
  for (const svc of ctx.config.services) {
    const vars = {
      ...adapterFor(svc.type).envVars(names),
      ...interpolateEnvs(svc.envs ?? {}, names, svc.name),
    }
    if (Object.keys(vars).length === 0) continue
    const dir = svc.dir ?? '.'
    byDir.set(dir, { ...(byDir.get(dir) ?? {}), ...vars })
  }
  return byDir
}

export function writeServiceEnvs(ctx: Ctx, worktreeDir: string, names: ResourceNames): void {
  for (const [dir, vars] of buildDirEnvs(ctx, names))
    writeEnvBlock(join(worktreeDir, dir, '.env'), vars)
}

export function removeServiceEnvs(ctx: Ctx, worktreeDir: string): void {
  for (const d of serviceEnvDirs(ctx)) removeEnvBlock(join(worktreeDir, d, '.env'))
}

export async function doAllocate(
  ctx: Ctx, worktreeDir: string, branch: string,
  providers: ResourceProvider[] = activeProviders(ctx),
  opts: { hook?: boolean } = {},
): Promise<{ n: number; reused: boolean; record: SetRecord }> {
  const result = await withState(ctx.config.project_name, async (state) => {
    // 幂等：当前目录若已分配，直接返回既有 Set，不重复创建资源、不覆盖 .env
    const existing = findSetByWorktree(state, worktreeDir)
    if (existing) return { n: Number(existing), reused: true, record: state.sets[existing] }

    state.project_name = ctx.config.project_name
    state.config_fingerprint = fingerprint(ctx.config)
    const { n, reuse } = await resolveSet(providers, ctx, state, maxAttempts(ctx))
    if (!reuse) await provisionSet(providers, ctx, n)
    try {
      const names = planNames(providers, ctx, n)
      state.sets[String(n)] = buildSetRecord(names, { worktree: worktreeDir, branch })
      writeServiceEnvs(ctx, worktreeDir, names)
      ensureGitignore(ctx.projectRoot, ['.env'])
      return { n, reused: false, record: state.sets[String(n)] }
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

  // 钩子在持锁的 withState 之外、.env 写好之后跑：仅当本次实际分配（非幂等命中）且未 --no-hook
  if (opts.hook !== false && !result.reused) {
    const names = planNames(providers, ctx, result.n)
    await runPostAllocate(ctx, worktreeDir, buildDirEnvs(ctx, names), result.n)
  }
  return result
}

export function registerAllocate(program: Command) {
  program.command('allocate').description('为当前 worktree 分配一套资源')
    .option('--no-hook', '分配后不运行 post_allocate 钩子')
    .action((opts: { hook: boolean }) => runCommand(async () => {
      const ctx = loadCtx()
      const { n, reused, record } = await doAllocate(ctx, process.cwd(), '(manual)', undefined, { hook: opts.hook })
      if (reused) {
        info(`当前 worktree 已分配 Set ${n}，跳过重复分配。现有资源：`)
        plain(renderSet(String(n), record, ctx.config))
      } else {
        success(`已分配 Set ${n}，并写入 .env`)
      }
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
