import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'

export const vite: FrameworkAdapter = {
  type: 'vite',
  detect: (dir) => ['vite.config.ts', 'vite.config.js'].some(f => existsSync(join(dir, f))),
  defaultStartCommand: (_svc, port) => `npm run dev -- --port ${port}`,
}
