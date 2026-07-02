import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { backendEnvVars } from './backendEnv.js'

export const django: FrameworkAdapter = {
  type: 'django',
  detect: (dir) => existsSync(join(dir, 'manage.py')),
  defaultInjectionMode: 'dotEnv',
  defaultStartCommand: () => 'uv run python manage.py runserver 0.0.0.0:{port}',
  envVars: backendEnvVars,
}
