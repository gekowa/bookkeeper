import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'
import { backendEnvVars } from './backendEnv.js'

export const fastapi: FrameworkAdapter = {
  type: 'fastapi',
  detect: (dir) => {
    const p = join(dir, 'pyproject.toml')
    return existsSync(p) && /fastapi/i.test(readFileSync(p, 'utf8'))
  },
  defaultStartCommand: (svc, port) => {
    if (!svc.app) throw new BkError(Codes.CONFIG_INVALID,
      `fastapi service ${svc.name} 需在 config 设置 app（如 app.main:app）或 command`)
    if (port === undefined) throw new BkError(Codes.CONFIG_INVALID,
      `fastapi service ${svc.name} 需要端口（设置 port_base）`)
    return `uv run uvicorn ${svc.app} --port ${port}`
  },
  envVars: backendEnvVars,
}
