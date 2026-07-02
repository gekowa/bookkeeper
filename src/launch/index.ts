import { join } from 'node:path'
import type { Ctx, SetRecord, RunHandle, RunService, ResolveContext } from '../core/types.js'
import { adapterFor } from '../frameworks/registry.js'
import { namesFromSet } from '../core/allocator.js'
import { BkError, Codes } from '../core/errors.js'
import { renderPrint } from './print.js'
import { runTmux } from './tmux.js'
import { runWt } from './wt.js'
import { runWin } from './win.js'
import { resolvePsHost } from './platform.js'
import { runIterm } from './iterm.js'

export interface LaunchSpec { name: string; command: string; cwd: string; port?: number }
export type Strategy = 'tmux' | 'iterm' | 'wt' | 'win' | 'print'
export type LaunchResult = RunHandle | null

export function buildLaunchSpecs(ctx: Ctx, set: SetRecord, worktreeDir: string, only?: string): LaunchSpec[] {
  const names = namesFromSet(set)
  return ctx.config.services
    .filter(s => !only || s.name === only)
    .map(s => {
      const port = names.ports[s.name]
      let command: string
      if (s.command) {
        if (s.command.includes('{port}') && port === undefined)
          throw new BkError(Codes.CONFIG_INVALID,
            `service ${s.name} 无端口但 command 引用了 {port}`,
            { remediation: '移除 {port} 或为该 service 设置 port_base' })
        command = port !== undefined ? s.command.replace(/\{port\}/g, String(port)) : s.command
      } else {
        const rc: ResolveContext = { self: s, names, infra: ctx.config.infra }
        command = adapterFor(s.type).defaultStartCommand(s, rc)
      }
      return { name: s.name, command, cwd: join(worktreeDir, s.dir ?? '.'), port }
    })
}

export function selectStrategy(
  env: NodeJS.ProcessEnv & { __platform?: string },
  opts: { force?: Strategy; hasWt?: boolean } = {},
): Strategy {
  if (opts.force) return opts.force
  if (env.TMUX) return 'tmux'
  const platform = env.__platform ?? process.platform
  if (platform === 'darwin' && env.TERM_PROGRAM === 'iTerm.app') return 'iterm'
  if (platform === 'win32') return opts.hasWt ? 'wt' : 'win'
  return 'print'
}

export async function runLaunch(specs: LaunchSpec[], strategy: Strategy): Promise<LaunchResult> {
  if (strategy === 'print') { console.log(renderPrint(specs)); return null }
  if (strategy === 'tmux') {
    const { session, paneIds } = await runTmux(specs)
    const services: RunService[] = specs.map((s, i) => ({ name: s.name, tmuxPaneId: paneIds[i] }))
    return { strategy: 'tmux', tmuxSession: session, services }
  }
  if (strategy === 'wt' || strategy === 'win') {
    const psHost = await resolvePsHost()
    const { pids } = strategy === 'wt' ? await runWt(specs, psHost) : await runWin(specs, psHost)
    const services: RunService[] = specs.map((s, i) => ({ name: s.name, pid: pids[i], port: s.port }))
    return { strategy, services }
  }
  const ids = await runIterm(specs)
  const services: RunService[] = specs.map((s, i) => ({ name: s.name, itermSessionId: ids[i] }))
  return { strategy: 'iterm', services }
}
