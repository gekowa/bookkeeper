import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'

export const vite: FrameworkAdapter = {
  type: 'vite',
  detect: (dir) => ['vite.config.ts', 'vite.config.js'].some(f => existsSync(join(dir, f))),
  defaultStartCommand: (_svc, port) => {
    if (port === undefined) throw new BkError(Codes.CONFIG_INVALID, 'vite service 需要端口（设置 port_base）')
    return `npm run dev -- --port ${port}`
  },
}
