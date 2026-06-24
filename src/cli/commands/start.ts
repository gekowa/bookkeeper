import type { Command } from 'commander'
import type { Ctx } from '../../core/types.js'
import { readState, withState } from '../../state/store.js'
import { findSetByWorktree } from '../../core/deallocator.js'
import { buildLaunchSpecs, selectStrategy, runLaunch, type Strategy } from '../../launch/index.js'
import { loadCtx, runCommand } from '../context.js'
import { BkError, Codes } from '../../core/errors.js'

export async function doStart(
  ctx: Ctx, worktreeDir: string, service?: string,
  force?: Strategy, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const project = ctx.config.project_name
  const state = await readState(project)
  const n = findSetByWorktree(state, worktreeDir)
  if (!n) throw new BkError(Codes.NOT_IN_WORKTREE,
    '当前 worktree 未分配资源', { remediation: '先运行 `bk allocate`' })
  if (state.sets[n].run)
    throw new BkError(Codes.SERVICE_RUNNING,
      '当前 worktree 已有服务在运行', { remediation: '改用 `bk restart`' })
  const specs = buildLaunchSpecs(ctx, state.sets[n], worktreeDir, service)
  const launched = await runLaunch(specs, selectStrategy(env, force))
  if (launched)
    await withState(project, s => {
      s.sets[n].run = { ...launched, startedAt: new Date().toISOString() }
    })
}

export function registerStart(program: Command) {
  program.command('start [service]').description('启动当前 worktree 的服务')
    .option('--tmux', '强制用 tmux 切 pane')
    .option('--iterm', '强制用 iTerm 切 pane')
    .option('--print', '只打印命令')
    .action((service: string | undefined, opts: { tmux?: boolean; iterm?: boolean; print?: boolean }) =>
      runCommand(async () => {
        const force: Strategy | undefined =
          opts.tmux ? 'tmux' : opts.iterm ? 'iterm' : opts.print ? 'print' : undefined
        await doStart(loadCtx(), process.cwd(), service, force)
      }))
}
