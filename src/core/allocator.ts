import type { ResourceProvider } from '../providers/types.js'
import type { Ctx, ResourceNames, SetRecord } from '../core/types.js'
import type { StateFile } from '../state/schema.js'
import { pickNumber } from './numbering.js'
import { BkError, Codes } from './errors.js'

export async function resolveSet(
  providers: ResourceProvider[], ctx: Ctx, state: StateFile, maxAttempts: number,
): Promise<{ n: number; reuse: boolean }> {
  let { n, reuse } = pickNumber(state)
  // free set 复用：信任快照、不再探活
  if (reuse) return { n, reuse }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let ok = true
    for (const p of providers) { if (!(await p.probe(n, ctx))) { ok = false; break } }
    if (ok) return { n, reuse: false }
    // 该号被占，标记为"占用"再选下一个空洞
    state.sets[String(n)] = { status: 'allocated', owner: null, resources: {}, created_at: '' }
    n = pickNumber(state).n
  }
  throw new BkError(Codes.PROBE_EXHAUSTED,
    `PROBE_EXHAUSTED: 连试 ${maxAttempts} 个编号都被占用，放弃。`,
    { remediation: '清理占用端口/库的野进程，或提高 allocation.max_probe_attempts' })
}

export async function provisionSet(providers: ResourceProvider[], ctx: Ctx, n: number): Promise<void> {
  const done: ResourceProvider[] = []
  try {
    for (const p of providers) { await p.provision(n, ctx); done.push(p) }
  } catch (e) {
    for (const p of done.reverse()) { try { await p.destroy(n, ctx) } catch { /* 回滚尽力 */ } }
    throw e
  }
}

export function collectEnv(providers: ResourceProvider[], ctx: Ctx, n: number): Record<string, string> {
  return Object.assign({}, ...providers.map(p => p.envVars(n, ctx)))
}

export function buildSetRecord(
  providers: ResourceProvider[], ctx: Ctx, n: number,
  owner: SetRecord['owner'],
): SetRecord {
  const names: Partial<ResourceNames> = Object.assign({}, ...providers.map(p => p.plan(n, ctx)))
  const resources: SetRecord['resources'] = {}
  for (const [svc, port] of Object.entries(names.ports ?? {})) resources[svc] = { port }
  if (names.database) resources.postgres = { database: names.database }
  if (names.redisPrefix || names.redisDb !== undefined)
    resources.redis = { prefix: names.redisPrefix, db: names.redisDb }
  if (names.bucket) resources.minio = { bucket: names.bucket }
  return { status: owner ? 'allocated' : 'free', owner, resources, created_at: new Date().toISOString() }
}
