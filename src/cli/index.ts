import { Command } from 'commander'
const program = new Command()
program.name('bk').description('BookKeeper — 并行 worktree 的本地资源记账员').version('0.0.1')
program.parseAsync(process.argv)
