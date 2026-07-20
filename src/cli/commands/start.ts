import type { Command } from 'commander'
import type { Ctx } from '../../core/types.js'
import { readState, withState } from '../../state/store.js'
import { findSetByWorktree } from '../../core/deallocator.js'
import { buildLaunchSpecs, selectStrategy, runLaunch, type Strategy } from '../../launch/index.js'
import { reconcileRun } from '../../launch/liveness.js'
import { hasWindowsTerminal } from '../../launch/platform.js'
import { loadCtx, runCommand } from '../context.js'
import { info } from '../output.js'
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
  const existing = state.sets[n].run
  if (existing) {
    // 不再裸信任 run 标志：探测句柄真实活性，剔除已死服务。
    const alive = await reconcileRun(existing)
    await withState(project, s => {
      if (alive) s.sets[n].run = alive   // 裁剪掉已死服务，保持 state 干净
      else delete s.sets[n].run          // 全死（如窗口被关）→ 清掉孤儿记录
    })
    if (alive) {                          // 仍有存活 → 幂等提示，不报错、不开窗
      info(`服务已在运行：${alive.services.map(s => s.name).join('、')}`)
      return
    }
    // 全死 → 落到下方正常启动
  }
  const specs = buildLaunchSpecs(ctx, state.sets[n], worktreeDir, service)
  const hasWt = force ? false : await hasWindowsTerminal(env)
  const launched = await runLaunch(specs, selectStrategy(env, { force, hasWt }))
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
