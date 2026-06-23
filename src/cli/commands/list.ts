import type { Command } from 'commander'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ProjectConfig } from '../../core/types.js'
import type { StateFile } from '../../state/schema.js'
import { readState } from '../../state/store.js'
import { pickNumber } from '../../core/numbering.js'
import { loadCtx, runCommand } from '../context.js'
import { plain } from '../output.js'

/** child 是否就是 parent 或位于 parent 之下（含子目录） */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 找出包含 currentDir 的已分配 set 号；嵌套时取路径最深（最具体）的那个 */
function findCurrentSet(state: StateFile, currentDir?: string): string | undefined {
  if (!currentDir) return undefined
  let best: string | undefined
  let bestLen = -1
  for (const [n, r] of Object.entries(state.sets)) {
    const wt = r.status === 'allocated' ? r.owner?.worktree : undefined
    if (wt && isWithin(wt, currentDir) && wt.length > bestLen) { best = n; bestLen = wt.length }
  }
  return best
}

/** 仅显示当前 bk_config.yml 仍声明的服务/基础设施；陈旧的持久化资源不再展示 */
export function renderSet(n: string, r: StateFile['sets'][string], config: ProjectConfig): string {
  const lines = [`  Set ${n}`]
  const names = new Set(config.services.map(s => s.name))
  for (const [k, v] of Object.entries(r.resources)) {
    if (v && 'port' in v && names.has(k)) lines.push(`    - ${k} ${v.port}`)
  }
  if (config.infra.postgres && r.resources.postgres) lines.push(`    - PostgreSQL: ${r.resources.postgres.database}`)
  if (config.infra.redis && r.resources.redis?.prefix) lines.push(`    - Redis prefix: ${r.resources.redis.prefix}`)
  if (config.infra.redis && r.resources.redis?.db !== undefined) lines.push(`    - Redis db: ${r.resources.redis.db}`)
  if (config.infra.minio && r.resources.minio) lines.push(`    - MinIO bucket: ${r.resources.minio.bucket}`)
  return lines.join('\n')
}

export function renderList(state: StateFile, projectName: string, config: ProjectConfig, currentDir?: string): string {
  const out: string[] = [`Project Name: ${projectName}`, '']
  const currentN = findCurrentSet(state, currentDir)
  const pushWorktree = (n: string, r: StateFile['sets'][string]) => {
    const tag = n === currentN ? '  ← 当前目录' : ''
    out.push(`Worktree: ${r.owner?.worktree}  (Set ${n})${tag}`)
    out.push(renderSet(n, r, config).split('\n').slice(1).join('\n'), '')
  }
  // 当前目录所在 worktree 置顶并标识，其余按原序紧随其后
  if (currentN) pushWorktree(currentN, state.sets[currentN])
  for (const [n, r] of Object.entries(state.sets)) {
    if (r.status !== 'allocated' || n === currentN) continue
    pushWorktree(n, r)
  }
  const frees = Object.entries(state.sets).filter(([, r]) => r.status === 'free')
  if (frees.length) {
    out.push('Unallocated (in pool):')
    for (const [n, r] of frees) out.push(renderSet(n, r, config))
    out.push('')
  }
  out.push(`Next free number: ${pickNumber({ ...state, sets: Object.fromEntries(
    Object.entries(state.sets).filter(([, r]) => r.status === 'allocated')) }).n}`)
  return out.join('\n')
}

export function registerList(program: Command) {
  program.command('list').description('列出已分配 worktree、空闲池与下一个可用号')
    .action(() => runCommand(async () => {
      const ctx = loadCtx()
      plain(renderList(await readState(ctx.config.project_name), ctx.config.project_name, ctx.config, process.cwd()))
    }))
}
