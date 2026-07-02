import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'
import { backendEnvVars } from './backendEnv.js'

export const celery: FrameworkAdapter = {
  type: 'celery',
  defaultInjectionMode: 'dotEnv',
  detect: () => false,
  defaultStartCommand: (svc, _rc) => {
    if (!svc.app) throw new BkError(Codes.CONFIG_INVALID,
      `celery service ${svc.name} 需在 config 设置 app（如 app.celery）或 command`)
    return `uv run celery -A ${svc.app} worker`
  },
  envVars: backendEnvVars,
}
