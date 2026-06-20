// src/cli/commands/destroy.ts
import type { Command } from 'commander'
import type { Ctx } from '../../core/types.js'
import { withState } from '../../state/store.js'
import { activeProviders } from '../../providers/registry.js'
import { destroySet } from '../../core/destroyer.js'
import { loadCtx, runCommand } from '../context.js'
import { confirm, success } from '../output.js'

export async function doDestroy(ctx: Ctx, n: number, opts: { force: boolean }): Promise<void> {
  await withState(ctx.config.project_name, (state) =>
    destroySet(activeProviders(ctx), ctx, state, n, opts))
}

export function registerDestroy(program: Command) {
  program.command('destroy <n>').description('销毁第 n 套资源（DROP DATABASE / 删桶，不可逆）')
    .option('--force', '即使正被 worktree 占用也销毁')
    .option('--yes', '跳过交互确认')
    .action((nStr: string, opts: { force?: boolean; yes?: boolean }) => runCommand(async () => {
      const ctx = loadCtx()
      const n = Number(nStr)
      if (!opts.yes) {
        const ok = await confirm(`确定销毁 Set ${n}？此操作不可逆（DROP DATABASE / 删桶）。`)
        if (!ok) { success('已取消'); return }
      }
      await doDestroy(ctx, n, { force: !!opts.force })
      success(`Set ${n} 已销毁`)
    }))
}
