import { join } from 'node:path'
import type { Ctx, SetRecord, RunHandle, RunService, ResolveContext } from '../core/types.js'
import { adapterFor, injectionModeFor } from '../frameworks/registry.js'
import { namesFromSet } from '../core/allocator.js'
import { BkError, Codes } from '../core/errors.js'
import { resolveTokens, interpolateEnvs } from '../inject/interpolate.js'
import { renderPrint } from './print.js'
import { runTmux } from './tmux.js'
import { runWt } from './wt.js'
import { runWin } from './win.js'
import { resolvePsHost } from './platform.js'
import { runIterm } from './iterm.js'
import { renderPosix, renderPowerShell } from './render.js'

export interface LaunchSpec {
  name: string; cwd: string; port?: number
  command?: string
  argv?: string[]
  env?: Record<string, string>
}
export type Strategy = 'tmux' | 'iterm' | 'wt' | 'win' | 'print'
export type LaunchResult = RunHandle | null

export function buildLaunchSpecs(ctx: Ctx, set: SetRecord, worktreeDir: string, only?: string): LaunchSpec[] {
  const names = namesFromSet(set)
  return ctx.config.services
    .filter(s => !only || s.name === only)
    .map(s => {
      const port = names.ports[s.name]
      const cwd = join(worktreeDir, s.dir ?? '.')
      const rc: ResolveContext = { self: s, names, infra: ctx.config.infra }

      if (injectionModeFor(s) === 'startupArgs') {
        if (!s.startCommand?.length)
          throw new BkError(Codes.CONFIG_INVALID,
            `service ${s.name}（injectionMode startupArgs）需要 startCommand`,
            { remediation: '在 bk_config.yml 为该 service 写 startCommand 数组' })
        const argv = s.startCommand.map(el => resolveTokens(el, rc, `service ${s.name} 的 startCommand`))
        const env = interpolateEnvs(s.envs ?? {}, rc)
        return { name: s.name, cwd, port, argv, env }
      }

      let command: string
      if (s.command) {
        if (s.command.includes('{port}') && port === undefined)
          throw new BkError(Codes.CONFIG_INVALID,
            `service ${s.name} 无端口但 command 引用了 {port}`,
            { remediation: '移除 {port} 或为该 service 设置 port_base' })
        command = port !== undefined ? s.command.replace(/\{port\}/g, String(port)) : s.command
      } else {
        command = adapterFor(s.type).defaultStartCommand(s, rc)
      }
      return { name: s.name, command, cwd, port }
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

// tmux/print 用：posix shell 下 env 前缀 + argv（无 argv 时原样用 command）。
export function posixLine(spec: LaunchSpec): string {
  return spec.argv ? renderPosix(spec.env ?? {}, spec.argv) : spec.command!
}
// win 用：env 走 spawn opts.env 注入，故这里渲染时传空 env。
export function psCommand(spec: LaunchSpec): string {
  return spec.argv ? renderPowerShell({}, spec.argv) : spec.command!
}
// wt 用：pane 里的 PowerShell 没有额外注入 env 的机会，需把 env 一并渲进命令串。
export function psPaneCommand(spec: LaunchSpec): string {
  return spec.argv ? renderPowerShell(spec.env ?? {}, spec.argv) : spec.command!
}
