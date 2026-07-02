import { join } from 'node:path'
import type { Ctx, SetRecord, RunHandle, RunService } from '../core/types.js'
import { adapterFor } from '../frameworks/registry.js'
import { setToResourceNames } from '../core/allocator.js'
import { buildInterpValues, interpolateCommand, resolveServiceEnvs } from '../inject/interpolate.js'
import { renderPrint } from './print.js'
import { runTmux } from './tmux.js'
import { runIterm } from './iterm.js'

export interface LaunchSpec { name: string; command: string; cwd: string }
export type Strategy = 'tmux' | 'iterm' | 'print'
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
      return { name: s.name, command, cwd: dir }
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
