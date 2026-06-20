// src/cli/index.ts
import { Command } from 'commander'
import { registerInit } from './commands/init.js'
import { registerAllocate } from './commands/allocate.js'
import { registerWorktree } from './commands/worktree.js'
import { registerList } from './commands/list.js'
import { registerStart } from './commands/start.js'
import { registerDestroy } from './commands/destroy.js'

const program = new Command()
program.name('bk').description('BookKeeper — 并行 worktree 的本地资源记账员').version('0.0.1')
registerInit(program)
registerAllocate(program)
registerWorktree(program)
registerList(program)
registerStart(program)
registerDestroy(program)
program.parseAsync(process.argv).catch(() => { process.exitCode = 1 })
