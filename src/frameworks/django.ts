import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'

export const django: FrameworkAdapter = {
  type: 'django',
  detect: (dir) => existsSync(join(dir, 'manage.py')),
  defaultStartCommand: (_svc, port) => {
    if (port === undefined) throw new BkError(Codes.CONFIG_INVALID, 'django service 需要端口（设置 port_base）')
    return `uv run python manage.py runserver 0.0.0.0:${port}`
  },
}
