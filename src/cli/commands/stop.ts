import type { Command } from 'commander'
import type { Ctx } from '../../core/types.js'
import { readState, withState } from '../../state/store.js'
import { findSetByWorktree } from '../../core/deallocator.js'
import { stopRun } from '../../launch/stop.js'
import { BkError, Codes } from '../../core/errors.js'
import { loadCtx, runCommand } from '../context.js'
import { info, success } from '../output.js'

export async function doStop(ctx: Ctx, worktreeDir: string, service?: string): Promise<void> {
  const project = ctx.config.project_name
  const state = await readState(project)
  const n = findSetByWorktree(state, worktreeDir)
  if (!n) throw new BkError(Codes.NOT_IN_WORKTREE,
    '当前 worktree 未分配资源', { remediation: '先运行 `bk allocate`' })
  const run = state.sets[n].run
  if (!run) { info('当前没有由 bk 启动的服务在运行'); return }
  if (service && !run.services.some(s => s.name === service)) {
    info(`服务 ${service} 未在运行`); return
  }
  const remaining = await stopRun(run, service)
  await withState(project, s => {
    if (remaining) s.sets[n].run = remaining
    else delete s.sets[n].run
  })
  success(service ? `已停止 ${service}` : '已停止当前 worktree 的服务')
}

export function registerStop(program: Command) {
  program.command('stop [service]').description('停止当前 worktree 的服务（不带参数 = 全部）')
    .action((service: string | undefined) =>
      runCommand(async () => { await doStop(loadCtx(), process.cwd(), service) }))
}
