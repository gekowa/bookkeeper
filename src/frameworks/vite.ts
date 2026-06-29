import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'

export const vite: FrameworkAdapter = {
  type: 'vite',
  detect: (dir) => ['vite.config.ts', 'vite.config.js'].some(f => existsSync(join(dir, f))),
  defaultStartCommand: (_svc, port) => {
    if (port === undefined) throw new BkError(Codes.CONFIG_INVALID, 'vite service 需要端口（设置 port_base）')
    // 直接调 vite（而非 npm run dev），免去 npm script 的间接层与差异；
    // --strictPort：端口被占用时直接退出，禁用 Vite 默认的端口 +1 回退，做到快速失败
    return `npx vite --port ${port} --strictPort`
  },
  envVars: () => ({}),
}
