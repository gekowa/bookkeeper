import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'

export const django: FrameworkAdapter = {
  type: 'django',
  detect: (dir) => existsSync(join(dir, 'manage.py')),
  defaultStartCommand: (_svc, port) => `uv run python manage.py runserver 0.0.0.0:${port}`,
}
