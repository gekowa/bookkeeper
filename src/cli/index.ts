// src/cli/index.ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { registerInit } from './commands/init.js'
import { registerAllocate } from './commands/allocate.js'
import { registerWorktree } from './commands/worktree.js'
import { registerList } from './commands/list.js'
import { registerStart } from './commands/start.js'
import { registerStop } from './commands/stop.js'
import { registerRestart } from './commands/restart.js'
import { registerDestroy } from './commands/destroy.js'
import { registerSetup } from './commands/setup.js'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string }

const program = new Command()
program.name('bk').description('BookKeeper — 并行 worktree 的本地资源记账员').version(pkg.version)
registerInit(program)
registerAllocate(program)
registerWorktree(program)
registerList(program)
registerStart(program)
registerStop(program)
registerRestart(program)
registerDestroy(program)
registerSetup(program)
program.parseAsync(process.argv).catch(() => { process.exitCode = 1 })
