import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'

export const vite: FrameworkAdapter = {
  type: 'vite',
  detect: (dir) => ['vite.config.ts', 'vite.config.js'].some(f => existsSync(join(dir, f))),
  defaultInjectionMode: 'dotEnv',
  // --strictPort：端口被占用时直接退出，禁用 Vite 默认 +1 回退
  defaultStartCommand: () => 'npm run dev -- --port {port} --strictPort',
  envVars: () => ({}),
}
