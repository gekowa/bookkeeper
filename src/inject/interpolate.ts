import type { Ctx, InfraConfig, ResourceNames, ServiceConfig } from '../core/types.js'
import type { FrameworkAdapter } from '../frameworks/types.js'
import { BkError, Codes } from '../core/errors.js'

export interface InterpValues {
  svcName: string
  ports: Record<string, number>
  infra: {
    postgres?: { database?: string; host?: string; port?: number; username?: string; password?: string }
    redis?: { db?: number; prefix?: string; host?: string; port?: number }
    minio?: { bucket?: string; endpoint?: string; access_key?: string; secret_key?: string }
    dameng?: { schema?: string; host?: string; port?: number; username?: string; password?: string }
  }
}

const TOKEN = /\{([^}]+)\}/g

function bail(svcName: string, tok: string, hint: string): never {
  throw new BkError(Codes.CONFIG_INVALID,
    `service ${svcName} 的占位符 {${tok}} 无法解析：${hint}`,
    { remediation: '检查占位符拼写，以及对应的 infra / 服务端口是否已声明并分配' })
}

function lookup(tok: string, v: InterpValues, args: string | undefined): string {
  if (tok === 'port') {
    const p = v.ports[v.svcName]
    if (p === undefined) bail(v.svcName, tok, '当前服务无端口（未设 port_base）')
    return String(p)
  }
  if (tok === 'args') {
    if (args === undefined) bail(v.svcName, tok, '{args} 只能用在 command 里，不能用在 envs 的值里')
    return args
  }
  let m: RegExpMatchArray | null
  if ((m = tok.match(/^service\.(.+)\.port$/)) || (m = tok.match(/^([^.]+)\.port$/))) {
    const p = v.ports[m[1]]
    if (p === undefined) bail(v.svcName, tok, `找不到服务 ${m[1]} 的端口`)
    return String(p)
  }
  if ((m = tok.match(/^infra\.(postgres|redis|minio|dameng)\.(\w+)$/))) {
    const sec = v.infra[m[1] as 'postgres' | 'redis' | 'minio' | 'dameng']
    const val = sec?.[m[2] as keyof typeof sec]
    if (val === undefined) bail(v.svcName, tok, `${m[1]}.${m[2]} 不可用（infra 未声明或资源未分配）`)
    return String(val)
  }
  bail(v.svcName, tok, '未知占位符格式')
}

function run(tmpl: string, v: InterpValues, args: string | undefined): string {
  return tmpl.replace(TOKEN, (_s, tok: string) => lookup(tok.trim(), v, args))
}

/** envs 值插值（不解析 {args}）。 */
export function interpolateEnvs(envs: Record<string, string>, v: InterpValues): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(envs)) out[k] = run(val, v, undefined)
  return out
}

/** 命令模板插值（解析 {args}）。 */
export function interpolateCommand(tmpl: string, v: InterpValues, args: string): string {
  return run(tmpl, v, args)
}

/** 从 ctx（静态 infra）+ names（动态分配）构造插值器输入。 */
export function buildInterpValues(ctx: Ctx, names: ResourceNames, svc: ServiceConfig): InterpValues {
  const i: InfraConfig = ctx.config.infra
  return {
    svcName: svc.name,
    ports: names.ports ?? {},
    infra: {
      postgres: (i.postgres || names.database) ? {
        host: i.postgres?.host, port: i.postgres?.port,
        username: i.postgres?.username, password: i.postgres?.password,
        database: names.database,
      } : undefined,
      redis: (i.redis || names.redisDb !== undefined || names.redisPrefix) ? {
        host: i.redis?.host, port: i.redis?.port, db: names.redisDb, prefix: names.redisPrefix,
      } : undefined,
      minio: (i.minio || names.bucket) ? {
        endpoint: i.minio?.endpoint, access_key: i.minio?.access_key, secret_key: i.minio?.secret_key,
        bucket: names.bucket,
      } : undefined,
      dameng: (i.dameng || names.dmSchema) ? {
        schema: names.dmSchema,
        host: i.dameng?.host, port: i.dameng?.port,
        username: i.dameng?.username, password: i.dameng?.password,
      } : undefined,
    },
  }
}

/** resolved envs：用户 envs 优先（全控替换默认），否则 adapter.envVars 回退。 */
export function resolveServiceEnvs(
  svc: ServiceConfig, adapter: FrameworkAdapter, ctx: Ctx, names: ResourceNames,
): Record<string, string> {
  if (svc.envs) return interpolateEnvs(svc.envs, buildInterpValues(ctx, names, svc))
  return adapter.envVars(names)
}
