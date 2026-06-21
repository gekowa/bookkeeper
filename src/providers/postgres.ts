import { Client } from 'pg'
import type { ResourceProvider } from './types.js'
import type { Ctx } from '../core/types.js'
import { BkError, Codes } from '../core/errors.js'

function dbName(n: number, ctx: Ctx) { return `${ctx.config.project_name}_${n}` }
function cfg(ctx: Ctx) {
  const pg = ctx.config.infra.postgres
  if (!pg) throw new BkError(Codes.CONFIG_INVALID, 'infra.postgres 未配置')
  return pg
}
async function withClient<T>(ctx: Ctx, fn: (c: Client) => Promise<T>): Promise<T> {
  const pg = cfg(ctx)
  const c = new Client({ host: pg.host, port: pg.port, user: pg.username, password: pg.password, database: 'postgres' })
  try { await c.connect() }
  catch (e: any) {
    throw new BkError(Codes.INFRA_UNREACHABLE, `无法连接 Postgres (${pg.host}:${pg.port})：${e.message}`,
      { recoverable: false, remediation: '你的本地开发数据库起了吗？' })
  }
  try { return await fn(c) } finally { await c.end() }
}

export function createPostgresProvider(): ResourceProvider {
  return {
    kind: 'postgres',
    plan: (n, ctx) => ({ database: dbName(n, ctx) }),
    probe: (n, ctx) => withClient(ctx, async (c) => {
      const r = await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName(n, ctx)])
      return r.rowCount === 0
    }),
    provision: (n, ctx) => withClient(ctx, async (c) => {
      await c.query(`CREATE DATABASE "${dbName(n, ctx)}"`)
    }),
    destroy: (n, ctx) => withClient(ctx, async (c) => {
      const name = dbName(n, ctx)
      await c.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [name])
      await c.query(`DROP DATABASE IF EXISTS "${name}"`)
    }),
    envVars: (n, ctx) => ({ BK_DB_NAME: dbName(n, ctx) }),
  }
}
