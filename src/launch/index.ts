import { join } from 'node:path'
import type { Ctx, SetRecord, RunHandle, RunService } from '../core/types.js'
import { adapterFor } from '../frameworks/registry.js'
import { setToResourceNames } from '../core/allocator.js'
import { buildInterpValues, interpolateCommand, resolveServiceEnvs } from '../inject/interpolate.js'
import { renderPrint } from './print.js'
import { runTmux } from './tmux.js'
import { runWt } from './wt.js'
import { runWin } from './win.js'
import { resolvePsHost } from './platform.js'
import { runIterm } from './iterm.js'

export interface LaunchSpec { name: string; command: string; cwd: string; port?: number }
export type Strategy = 'tmux' | 'iterm' | 'wt' | 'win' | 'print'
export type LaunchResult = RunHandle | null

const renderArgs = (envs: Record<string, string>): string =>
  Object.entries(envs).map(([k, v]) => `--${k}=${v}`).join(' ')

export function buildLaunchSpecs(ctx: Ctx, set: SetRecord, worktreeDir: string, only?: string): LaunchSpec[] {
  const names = setToResourceNames(set)
  return ctx.config.services
    .filter(s => !only || s.name === only)
    .map(s => {
      const dir = join(worktreeDir, s.dir ?? '.')
      const adapter = adapterFor(s.type)
      const values = buildInterpValues(ctx, names, s)
      const resolvedEnvs = resolveServiceEnvs(s, adapter, ctx, names)
      const args = renderArgs(resolvedEnvs)
      const tmpl = s.command ?? adapter.defaultStartCommand(s, dir)
      const command = interpolateCommand(tmpl, values, args)
      const port = (set.resources[s.name] as { port: number } | undefined)?.port
      return { name: s.name, command, cwd: dir, port }
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
