import type { ResolveContext } from '../core/types.js'
import { BkError, Codes } from '../core/errors.js'

const TOKEN = /\{([^}]+)\}/g
const REMEDIATION = '检查 token 拼写、目标 service 是否配 port_base、infra 是否配了该项'

function fail(where: string, expr: string, why: string): never {
  throw new BkError(Codes.CONFIG_INVALID, `${where} 引用了 {${expr}}，${why}`, { remediation: REMEDIATION })
}

function portOf(name: string, rc: ResolveContext, where: string, expr: string): string {
  const p = rc.names.ports?.[name]
  if (p === undefined) fail(where, expr, `但找不到 service ${name} 的端口`)
  return String(p)
}

const GROUP = new Set(['db', 'redis', 'minio', 'infra'])

function resolveOne(expr: string, rc: ResolveContext, where: string): string {
  if (expr === 'port' || expr === 'self.port') return portOf(rc.self.name, rc, where, expr)
  const svc = expr.match(/^([A-Za-z0-9_-]+)\.port$/)
  if (svc && !GROUP.has(svc[1])) return portOf(svc[1], rc, where, expr)
  if (expr === 'db.name') { if (!rc.names.database) fail(where, expr, '但本套未分配数据库'); return rc.names.database }
  if (expr === 'redis.db') { if (rc.names.redisDb === undefined) fail(where, expr, '但本套未用 db_number 隔离'); return String(rc.names.redisDb) }
  if (expr === 'redis.prefix') { if (!rc.names.redisPrefix) fail(where, expr, '但本套未用 key_prefix 隔离'); return rc.names.redisPrefix }
  if (expr === 'minio.bucket') { if (!rc.names.bucket) fail(where, expr, '但本套未分配桶'); return rc.names.bucket }
  const infra = expr.match(/^infra\.(postgres|redis|minio)\.([A-Za-z_]+)$/)
  if (infra) {
    const grp = (rc.infra as Record<string, Record<string, unknown> | undefined>)[infra[1]]
    const v = grp?.[infra[2]]
    if (v === undefined || v === null) fail(where, expr, `但 infra.${infra[1]}.${infra[2]} 未配置`)
    return String(v)
  }
  fail(where, expr, '无法识别该 token')
}

export function resolveTokens(value: string, rc: ResolveContext, where: string): string {
  return value.replace(TOKEN, (_m, expr: string) => resolveOne(expr.trim(), rc, where))
}

export function interpolateEnvs(envs: Record<string, string>, rc: ResolveContext): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(envs))
    out[k] = resolveTokens(v, rc, `service ${rc.self.name} 的 envs.${k}`)
  return out
}
