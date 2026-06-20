import type { Command } from 'commander'
import type { StateFile } from '../../state/schema.js'
import { readState } from '../../state/store.js'
import { pickNumber } from '../../core/numbering.js'
import { loadCtx, runCommand } from '../context.js'
import { plain } from '../output.js'

function renderSet(n: string, r: StateFile['sets'][string]): string {
  const lines = [`  Set ${n}`]
  for (const [k, v] of Object.entries(r.resources)) {
    if (v && 'port' in v) lines.push(`    - ${k} ${v.port}`)
  }
  if (r.resources.postgres) lines.push(`    - PostgreSQL: ${r.resources.postgres.database}`)
  if (r.resources.redis?.prefix) lines.push(`    - Redis prefix: ${r.resources.redis.prefix}`)
  if (r.resources.redis?.db !== undefined) lines.push(`    - Redis db: ${r.resources.redis.db}`)
  if (r.resources.minio) lines.push(`    - MinIO bucket: ${r.resources.minio.bucket}`)
  return lines.join('\n')
}

export function renderList(state: StateFile, projectName: string): string {
  const out: string[] = [`Project Name: ${projectName}`, '']
  for (const [n, r] of Object.entries(state.sets)) {
    if (r.status !== 'allocated') continue
    out.push(`Worktree: ${r.owner?.worktree}  (Set ${n})`)
    out.push(renderSet(n, r).split('\n').slice(1).join('\n'), '')
  }
  const frees = Object.entries(state.sets).filter(([, r]) => r.status === 'free')
  if (frees.length) {
    out.push('Unallocated (in pool):')
    for (const [n, r] of frees) out.push(renderSet(n, r))
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
      plain(renderList(await readState(ctx.config.project_name), ctx.config.project_name))
    }))
}
