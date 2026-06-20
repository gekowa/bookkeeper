// src/providers/registry.ts
import type { ResourceProvider } from './types.js'
import type { Ctx } from '../core/types.js'
import { createPortProvider } from './port.js'
import { createPostgresProvider } from './postgres.js'
import { createRedisProvider } from './redis.js'
import { createMinioProvider } from './minio.js'

export function activeProviders(ctx: Ctx): ResourceProvider[] {
  const list: ResourceProvider[] = [createPortProvider()]
  if (ctx.config.infra.postgres) list.push(createPostgresProvider())
  if (ctx.config.infra.redis) list.push(createRedisProvider())
  if (ctx.config.infra.minio) list.push(createMinioProvider())
  return list
}
