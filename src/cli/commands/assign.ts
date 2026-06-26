// src/cli/commands/assign.ts
import type { Command } from 'commander'
import type { Ctx, SetRecord } from '../../core/types.js'
import type { ResourceProvider } from '../../providers/types.js'
import { withState } from '../../state/store.js'
import { activeProviders } from '../../providers/registry.js'
import { planNames } from '../../core/allocator.js'
import { findSetByWorktree, deallocateInState } from '../../core/deallocator.js'
import { runPostAllocate } from '../../hooks/postAllocate.js'
import { ensureGitignore } from '../../inject/gitignore.js'
import { BkError, Codes } from '../../core/errors.js'
import { loadCtx, runCommand } from '../context.js'
import { writeServiceEnvs, removeServiceEnvs, buildDirEnvs } from './allocate.js'
import { renderSet } from './list.js'
import { success, info, plain } from '../output.js'

export function parseSetNumber(arg: string): number {
  const n = Number(arg)
  if (!Number.isInteger(n) || n < 1)
    throw new BkError(Codes.CONFIG_INVALID, `编号必须是 ≥1 的整数，收到：${arg}`,
      { remediation: '用 bk list 查看现有编号' })
  return n
}

export async function doAssign(
  ctx: Ctx, n: number, worktreeDir: string,
  providers: ResourceProvider[] = activeProviders(ctx),
  opts: { force?: boolean; hook?: boolean } = {},
): Promise<{ n: number; reused: boolean; record: SetRecord; repointedFrom?: number }> {
  const result = await withState(ctx.config.project_name, (state) => {
    const key = String(n)
    const target = state.sets[key]

    if (!target)
      throw new BkError(Codes.SET_NOT_FOUND, `第 ${n} 套资源不存在（记错号，或已被 destroy）`,
        { remediation: '用 bk list 核对现有编号；如需新建资源用 bk allocate' })

    if (target.status === 'allocated') {
      if (target.owner?.worktree === worktreeDir)
        return { n, reused: true, record: target }  // 幂等：不写 .env、不跑钩子
      throw new BkError(Codes.SET_IN_USE, `第 ${n} 套正被另一个 worktree 占用：${target.owner?.worktree}`,
        { remediation: '换个空闲编号，或在那个 worktree 里先 bk deallocate' })
    }

    // 此处 target 必为 free
    let repointedFrom: number | undefined
    const existing = findSetByWorktree(state, worktreeDir)
    if (existing && existing !== key) {
      if (!opts.force)
        throw new BkError(Codes.ALREADY_ALLOCATED, `当前 worktree 已绑定 Set ${existing}`,
          { remediation: '先 bk deallocate，或加 --force 直接换绑' })
      deallocateInState(state, existing)
      removeServiceEnvs(ctx, worktreeDir)
      repointedFrom = Number(existing)
    }

    // 复活既有 free SetRecord：保留 resources/created_at，仅翻 status + 写 owner。
    // 刻意不像 allocate 那样用 buildSetRecord 重建——assign 的语义是“认领既有”，
    // 故保留原始 resources/created_at（恢复用例需要）。.env 由下方 planNames(n) 现算，
    // 与既有 resources 一致（同一 N 推导同名）；勿改成 buildSetRecord。
    target.status = 'allocated'
    target.owner = { worktree: worktreeDir, branch: '(manual)' }
    const names = planNames(providers, ctx, n)
    writeServiceEnvs(ctx, worktreeDir, names)
    ensureGitignore(ctx.projectRoot, ['.env'])
    return { n, reused: false, record: target, repointedFrom }
  })

  // 钩子在持锁的 withState 之外、.env 写好之后跑：仅当实际绑定（非幂等）且未 --no-hook
  if (opts.hook !== false && !result.reused) {
    const names = planNames(providers, ctx, result.n)
    await runPostAllocate(ctx, worktreeDir, buildDirEnvs(ctx, names), result.n)
  }
  return result
}

export function registerAssign(program: Command) {
  program.command('assign <n>')
    .description('把当前 worktree 绑定到已存在的第 N 套资源（只复用，不创建）')
    .option('--force', '当前目录已绑别的号时，先退回再绑 N')
    .option('--no-hook', '绑定后不运行 post_allocate 钩子')
    .action((nArg: string, opts: { force?: boolean; hook: boolean }) => runCommand(async () => {
      const n = parseSetNumber(nArg)
      const ctx = loadCtx()
      const { reused, record, repointedFrom } =
        await doAssign(ctx, n, process.cwd(), undefined, { force: opts.force, hook: opts.hook })
      if (reused) {
        info(`当前 worktree 已绑定 Set ${n}。现有资源：`)
        plain(renderSet(String(n), record, ctx.config))
      } else if (repointedFrom !== undefined) {
        success(`Set ${repointedFrom} 已退回池子，当前 worktree 改绑 Set ${n}，并重写 .env`)
      } else {
        success(`已将当前 worktree 绑定到 Set ${n}，并写入 .env`)
      }
    }))
}
