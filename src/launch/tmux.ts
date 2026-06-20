import { execa } from 'execa'
import type { LaunchSpec } from './index.js'

export async function runTmux(specs: LaunchSpec[]): Promise<void> {
  if (!specs.length) return
  const [first, ...rest] = specs
  const session = `bk-${first.cwd.split('/').pop()}`
  await execa('tmux', ['new-session', '-d', '-s', session, '-c', first.cwd, first.command])
  for (const s of rest)
    await execa('tmux', ['split-window', '-t', session, '-c', s.cwd, s.command])
  await execa('tmux', ['select-layout', '-t', session, 'tiled'])
  console.log(`tmux 会话 ${session} 已启动：tmux attach -t ${session}`)
}
