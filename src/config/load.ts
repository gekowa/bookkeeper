import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { BkError, Codes } from '../core/errors.js'
import type { ProjectConfig, ServiceConfig } from '../core/types.js'

export function loadConfig(projectRoot: string): ProjectConfig {
  const raw = parse(readFileSync(join(projectRoot, 'bk_config.yml'), 'utf8')) ?? {}
  if (!raw.project_name) throw new BkError(Codes.CONFIG_INVALID, 'bk_config.yml 缺少 project_name')
  const servicesObj = raw.services ?? {}
  const services: ServiceConfig[] = Object.entries<any>(servicesObj).map(([name, s]) => {
    if (!s?.type) throw new BkError(Codes.CONFIG_INVALID, `service ${name} 缺少 type`)
    if (s.port_base !== undefined && typeof s.port_base !== 'number')
      throw new BkError(Codes.CONFIG_INVALID, `service ${name} 的 port_base 必须是数字`)
    if (s.envs !== undefined && (typeof s.envs !== 'object' || Array.isArray(s.envs)))
      throw new BkError(Codes.CONFIG_INVALID, `service ${name} 的 envs 必须是键值映射`)
    if (s.injectionMode !== undefined && !['dotEnv', 'startupArgs'].includes(s.injectionMode))
      throw new BkError(Codes.CONFIG_INVALID,
        `service ${name} 的 injectionMode 必须是 dotEnv 或 startupArgs`)
    return {
      name, type: s.type, port_base: s.port_base, command: s.command, app: s.app,
      dir: s.dir, envs: s.envs, injectionMode: s.injectionMode, post_allocate: s.post_allocate,
    }
  })
  return {
    project_name: raw.project_name,
    services,
    infra: raw.infra ?? {},
    allocation: raw.allocation,
  }
}
