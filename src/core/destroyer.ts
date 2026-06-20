import type { ResourceProvider } from '../providers/types.js'
import type { Ctx } from '../core/types.js'
import type { StateFile } from '../state/schema.js'
import { BkError, Codes } from './errors.js'

export async function destroySet(
  providers: ResourceProvider[], ctx: Ctx, state: StateFile, n: number,
  opts: { force: boolean },
): Promise<void> {
  const key = String(n)
  const r = state.sets[key]
  if (!r) throw new BkError(Codes.CONFIG_INVALID, `编号 ${n} 不存在`)
  if (r.status === 'allocated' && !opts.force)
    throw new BkError(Codes.SET_IN_USE,
      `编号 ${n} 正被 ${r.owner?.worktree} 使用`,
      { remediation: '先 deallocate / bk worktree delete，或加 --force' })
  for (const p of providers) { try { await p.destroy(n, ctx) } catch { /* 尽力销毁 */ } }
  delete state.sets[key]
}
