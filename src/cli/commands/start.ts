import type { Command } from 'commander'
import { readState } from '../../state/store.js'
import { findSetByWorktree } from '../../core/deallocator.js'
import { buildLaunchSpecs, selectStrategy, runLaunch, type Strategy } from '../../launch/index.js'
import { loadCtx, runCommand } from '../context.js'
import { BkError, Codes } from '../../core/errors.js'

export function registerStart(program: Command) {
  program.command('start [service]').description('启动当前 worktree 的服务')
    .option('--tmux', '强制用 tmux 切 pane')
    .option('--iterm', '强制用 iTerm 切 pane')
    .option('--print', '只打印命令')
    .action((service: string | undefined, opts: { tmux?: boolean; iterm?: boolean; print?: boolean }) =>
      runCommand(async () => {
        const ctx = loadCtx()
        const wt = process.cwd()
        const state = await readState(ctx.config.project_name)
        const n = findSetByWorktree(state, wt)
        if (!n) throw new BkError(Codes.NOT_IN_WORKTREE,
          '当前 worktree 未分配资源', { remediation: '先运行 `bk allocate`' })
        const specs = buildLaunchSpecs(ctx, state.sets[n], wt, service)
        const force: Strategy | undefined =
          opts.tmux ? 'tmux' : opts.iterm ? 'iterm' : opts.print ? 'print' : undefined
        await runLaunch(specs, selectStrategy(process.env, force))
      }))
}
