import type { ResourceNames } from '../core/types.js'

export function backendEnvVars(names: ResourceNames): Record<string, string> {
  const out: Record<string, string> = {}
  if (names.database) out.BK_DB_NAME = names.database
  if (names.redisDb !== undefined) out.BK_REDIS_DB = String(names.redisDb)
  else if (names.redisPrefix) out.BK_REDIS_PREFIX = names.redisPrefix
  if (names.bucket) out.BK_MINIO_BUCKET = names.bucket
  if (names.dmSchema) out.BK_DM_SCHEMA = names.dmSchema
  return out
}
