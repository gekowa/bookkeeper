import type { ResourceProvider } from './types.js'
import type { Ctx } from '../core/types.js'
import { BkError, Codes } from '../core/errors.js'

function cfg(ctx: Ctx) {
  const r = ctx.config.infra.redis
  if (!r) throw new BkError(Codes.CONFIG_INVALID, 'infra.redis 未配置')
  return r
}
function prefix(n: number, ctx: Ctx) { return `${ctx.config.project_name}_${n}_` }

export function createRedisProvider(): ResourceProvider {
  return {
    kind: 'redis',
    plan: (n, ctx) => cfg(ctx).isolation === 'db_number'
      ? { redisDb: n } : { redisPrefix: prefix(n, ctx) },
    probe: async (n, ctx) => {
      if (cfg(ctx).isolation === 'db_number' && n > 15)
        throw new BkError(Codes.REDIS_DB_EXHAUSTED,
          `redis db_number 模式仅支持 0-15，编号 ${n} 越界`,
          { recoverable: false, remediation: '改用 isolation: key_prefix 以突破 15 套上限' })
      return true   // 两模式均无需预建
    },
    provision: async () => {},
    destroy: async () => {},   // key_prefix 可选 SCAN+DEL，首批不做
    envVars: (n, ctx): Record<string, string> => cfg(ctx).isolation === 'db_number'
      ? { BK_REDIS_DB: String(n) }
      : { BK_REDIS_PREFIX: prefix(n, ctx) },
  }
}
