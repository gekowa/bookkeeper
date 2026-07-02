import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'
import { backendEnvVars } from './backendEnv.js'

export const django: FrameworkAdapter = {
  type: 'django',
  defaultInjectionMode: 'dotEnv',
  detect: (dir) => existsSync(join(dir, 'manage.py')),
  defaultStartCommand: (svc, rc) => {
    const port = rc.names.ports[svc.name]
    if (port === undefined) throw new BkError(Codes.CONFIG_INVALID, 'django service 需要端口（设置 port_base）')
    return `uv run python manage.py runserver 0.0.0.0:${port}`
  },
  envVars: backendEnvVars,
}
