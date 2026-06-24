import type { Command } from 'commander'
import type { Ctx } from '../../core/types.js'
import { readState, withState } from '../../state/store.js'
import { findSetByWorktree } from '../../core/deallocator.js'
import { buildLaunchSpecs, selectStrategy, runLaunch } from '../../launch/index.js'
import { stopRun } from '../../launch/stop.js'
import { mergeRun } from '../../core/run.js'
import { BkError, Codes } from '../../core/errors.js'
import { loadCtx, runCommand } from '../context.js'
import { success } from '../output.js'

export async function doRestart(
  ctx: Ctx, worktreeDir: string, service?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const project = ctx.config.project_name
  const state = await readState(project)
  const n = findSetByWorktree(state, worktreeDir)
  if (!n) throw new BkError(Codes.NOT_IN_WORKTREE,
    '当前 worktree 未分配资源', { remediation: '先运行 `bk allocate`' })
  const run = state.sets[n].run

  // 1. 停（仅当有 run 且目标确实在运行）
  const willStop = run && (!service || run.services.some(s => s.name === service))
  if (run && willStop) {
    const remaining = await stopRun(run, service)
    await withState(project, s => {
      if (remaining) s.sets[n].run = remaining
      else delete s.sets[n].run
    })
  }

  // 2. 重读配置后启动；沿用原 run 的 strategy，无 run 则探测
  const specs = buildLaunchSpecs(ctx, state.sets[n], worktreeDir, service)
  const strategy = run?.strategy ?? selectStrategy(env)
  const launched = await runLaunch(specs, strategy)

  // 3. 把新句柄并回 run 记录
  await withState(project, s => {
    const merged = mergeRun(s.sets[n].run, launched, new Date().toISOString())
    if (merged) s.sets[n].run = merged
    else delete s.sets[n].run
  })
  success(service ? `已重启 ${service}` : '已重启当前 worktree 的服务')
}

export function registerRestart(program: Command) {
  program.command('restart [service]').description('重启当前 worktree 的服务（= stop + start，重读配置）')
    .action((service: string | undefined) =>
      runCommand(async () => { await doRestart(loadCtx(), process.cwd(), service) }))
}
