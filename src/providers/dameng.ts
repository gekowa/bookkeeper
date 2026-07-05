import dmdb from 'dmdb'
import type { ResourceProvider } from './types.js'
import type { Ctx } from '../core/types.js'
import { BkError, Codes } from '../core/errors.js'

function schemaName(n: number, ctx: Ctx) { return `${ctx.config.project_name}_${n}`.toUpperCase() }
function cfg(ctx: Ctx) {
  const dm = ctx.config.infra.dameng
  if (!dm) throw new BkError(Codes.CONFIG_INVALID, 'infra.dameng 未配置')
  return dm
}
async function withClient<T>(ctx: Ctx, fn: (c: dmdb.Connection) => Promise<T>): Promise<T> {
  const dm = cfg(ctx)
  let c: dmdb.Connection
  try {
    c = await dmdb.getConnection({
      user: dm.username, password: dm.password, connectString: `${dm.host}:${dm.port}`,
    })
  } catch (e: any) {
    throw new BkError(Codes.INFRA_UNREACHABLE, `无法连接达梦 (${dm.host}:${dm.port})：${e.message}`,
      { recoverable: false, remediation: '你的本地达梦数据库起了吗？' })
  }
  try { return await fn(c) } finally { await c.close() }
}

// schema 不存在 → true(可分配)；存在 → false(撞了→跳号)。系统目录列名以本机集成测试为准绳。
const SCHEMA_EXISTS_SQL = `SELECT 1 FROM SYSOBJECTS WHERE TYPE$ = 'SCH' AND NAME = ?`

export function createDamengProvider(): ResourceProvider {
  return {
    kind: 'dameng',
    plan: (n, ctx) => ({ dmSchema: schemaName(n, ctx) }),
    probe: (n, ctx) => withClient(ctx, async (c) => {
      const r = await c.execute(SCHEMA_EXISTS_SQL, [schemaName(n, ctx)])
      return (r.rows?.length ?? 0) === 0
    }),
    provision: (n, ctx) => withClient(ctx, async (c) => {
      await c.execute(`CREATE SCHEMA "${schemaName(n, ctx)}"`)
    }),
    destroy: (n, ctx) => withClient(ctx, async (c) => {
      const name = schemaName(n, ctx)
      const r = await c.execute(SCHEMA_EXISTS_SQL, [name])
      if ((r.rows?.length ?? 0) === 0) return   // schema 不存在 → 幂等，直接返回（不依赖 DM 是否支持 IF EXISTS）
      await c.execute(`DROP SCHEMA "${name}" CASCADE`)
    }),
  }
}
