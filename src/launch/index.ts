import { join } from 'node:path'
import type { Ctx, SetRecord, RunHandle, RunService } from '../core/types.js'
import { adapterFor } from '../frameworks/registry.js'
import { BkError, Codes } from '../core/errors.js'
import { renderPrint } from './print.js'
import { runTmux } from './tmux.js'
import { runIterm } from './iterm.js'

export interface LaunchSpec { name: string; command: string; cwd: string; port?: number }
export type Strategy = 'tmux' | 'iterm' | 'print' | 'wt' | 'win'
export type LaunchResult = RunHandle | null

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
        command = port !== undefined
          ? s.command.replace(/\{port\}/g, String(port))
          : s.command
      } else {
        command = adapterFor(s.type).defaultStartCommand(s, port)
      }
      return { name: s.name, command, cwd: join(worktreeDir, s.dir ?? '.'), port }
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

export async function runLaunch(specs: LaunchSpec[], strategy: Strategy): Promise<LaunchResult> {
  if (strategy === 'print') { console.log(renderPrint(specs)); return null }
  if (strategy === 'tmux') {
    const { session, paneIds } = await runTmux(specs)
    const services: RunService[] = specs.map((s, i) => ({ name: s.name, tmuxPaneId: paneIds[i] }))
    return { strategy: 'tmux', tmuxSession: session, services }
  }
  const ids = await runIterm(specs)
  const services: RunService[] = specs.map((s, i) => ({ name: s.name, itermSessionId: ids[i] }))
  return { strategy: 'iterm', services }
}
