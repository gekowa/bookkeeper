import { createServer } from 'node:net'
import type { ResourceProvider } from './types.js'
import type { Ctx } from '../core/types.js'

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

export function createPortProvider(): ResourceProvider {
  const ports = (n: number, ctx: Ctx) =>
    Object.fromEntries(
      ctx.config.services
        .filter(s => s.port_base !== undefined)
        .map(s => [s.name, (s.port_base as number) + n]))
  return {
    kind: 'port',
    plan: (n, ctx) => ({ ports: ports(n, ctx) }),
    probe: async (n, ctx) => {
      for (const p of Object.values(ports(n, ctx))) if (!(await portFree(p))) return false
      return true
    },
    provision: async () => {},
    destroy: async () => {},
    envVars: () => ({}),
  }
}
