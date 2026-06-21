import { join } from 'node:path'
import type { Ctx, SetRecord } from '../core/types.js'
import { adapterFor } from '../frameworks/registry.js'
import { BkError, Codes } from '../core/errors.js'
import { renderPrint } from './print.js'
import { runTmux } from './tmux.js'
import { runIterm } from './iterm.js'

export interface LaunchSpec { name: string; command: string; cwd: string }
export type Strategy = 'tmux' | 'iterm' | 'print'

export function buildLaunchSpecs(ctx: Ctx, set: SetRecord, worktreeDir: string, only?: string): LaunchSpec[] {
  return ctx.config.services
    .filter(s => !only || s.name === only)
    .map(s => {
      const port = (set.resources[s.name] as { port: number } | undefined)?.port
      let command: string
      if (s.command) {
        if (s.command.includes('{port}') && port === undefined)
          throw new BkError(Codes.CONFIG_INVALID,
            `service ${s.name} 无端口但 command 引用了 {port}`,
            { remediation: '移除 {port} 或为该 service 设置 port_base' })
        command = s.command.replace(/\{port\}/g, String(port))
      } else {
        command = adapterFor(s.type).defaultStartCommand(s, port)
      }
      return { name: s.name, command, cwd: join(worktreeDir, s.dir ?? '.') }
    })
}

export function selectStrategy(
  env: NodeJS.ProcessEnv & { __platform?: string }, force?: Strategy,
): Strategy {
  if (force) return force
  if (env.TMUX) return 'tmux'
  const platform = env.__platform ?? process.platform
  if (platform === 'darwin' && env.TERM_PROGRAM === 'iTerm.app') return 'iterm'
  return 'print'
}

export async function runLaunch(specs: LaunchSpec[], strategy: Strategy): Promise<void> {
  if (strategy === 'print') { console.log(renderPrint(specs)); return }
  if (strategy === 'tmux') { await runTmux(specs); return }
  await runIterm(specs)
}
