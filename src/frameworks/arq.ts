import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'
import { backendEnvVars } from './backendEnv.js'

export const arq: FrameworkAdapter = {
  type: 'arq',
  detect: () => false,
  defaultStartCommand: (svc) => {
    if (!svc.app) throw new BkError(Codes.CONFIG_INVALID,
      `arq service ${svc.name} 需在 config 设置 app（如 app.worker）或 command`)
    return `uv run arq ${svc.app}.WorkerSettings`
  },
  envVars: backendEnvVars,
}
