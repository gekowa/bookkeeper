// src/providers/minio.ts
import { Client } from 'minio'
import type { ResourceProvider } from './types.js'
import type { Ctx } from '../core/types.js'
import { BkError, Codes } from '../core/errors.js'

function bucket(n: number, ctx: Ctx) { return `${ctx.config.project_name}-${n}` }
function client(ctx: Ctx): Client {
  const m = ctx.config.infra.minio
  if (!m) throw new BkError(Codes.CONFIG_INVALID, 'infra.minio 未配置')
  const [host, port] = m.endpoint.split(':')
  return new Client({ endPoint: host, port: Number(port) || 9000, useSSL: false,
    accessKey: m.access_key, secretKey: m.secret_key })
}
function wrap(ctx: Ctx, e: any): never {
  throw new BkError(Codes.INFRA_UNREACHABLE, `无法连接 MinIO：${e.message}`,
    { recoverable: false, remediation: '检查 infra.minio.endpoint 与本地 MinIO 是否运行' })
}

export function createMinioProvider(): ResourceProvider {
  return {
    kind: 'minio',
    plan: (n, ctx) => ({ bucket: bucket(n, ctx) }),
    probe: async (n, ctx) => {
      try { return !(await client(ctx).bucketExists(bucket(n, ctx))) }
      catch (e) { wrap(ctx, e) }
    },
    provision: async (n, ctx) => {
      try { await client(ctx).makeBucket(bucket(n, ctx)) } catch (e) { wrap(ctx, e) }
    },
    destroy: async (n, ctx) => {
      try {
        const c = client(ctx); const b = bucket(n, ctx)
        const stream = c.listObjectsV2(b, '', true)
        const names: string[] = await new Promise((res, rej) => {
          const acc: string[] = []
          stream.on('data', (o) => o.name && acc.push(o.name))
          stream.on('end', () => res(acc)); stream.on('error', rej)
        })
        if (names.length) await c.removeObjects(b, names)
        await c.removeBucket(b)
      } catch (e) { wrap(ctx, e) }
    },
  }
}
