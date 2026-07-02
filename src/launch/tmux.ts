import { basename } from 'node:path'
import { execa } from 'execa'
import type { LaunchSpec } from './index.js'
import { posixLine } from './index.js'

export async function runTmux(specs: LaunchSpec[]): Promise<{ session: string; paneIds: string[] }> {
  if (!specs.length) return { session: '', paneIds: [] }
  const [first, ...rest] = specs
  const session = `bk-${basename(first.cwd)}`
  const paneIds: string[] = []
  const r0 = await execa('tmux',
    ['new-session', '-d', '-s', session, '-c', first.cwd, '-P', '-F', '#{pane_id}', posixLine(first)])
  paneIds.push(r0.stdout.trim())
  for (const s of rest) {
    const r = await execa('tmux',
      ['split-window', '-t', session, '-c', s.cwd, '-P', '-F', '#{pane_id}', posixLine(s)])
    paneIds.push(r.stdout.trim())
  }
  await execa('tmux', ['select-layout', '-t', session, 'tiled'])
  console.log(`tmux 会话 ${session} 已启动：tmux attach -t ${session}`)
  return { session, paneIds }
}
