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
    if (s.startCommand !== undefined &&
        (!Array.isArray(s.startCommand) || s.startCommand.some((x: unknown) => typeof x !== 'string')))
      throw new BkError(Codes.CONFIG_INVALID, `service ${name} 的 startCommand 必须是字符串数组`)
    if (s.startCommand !== undefined && s.command !== undefined)
      throw new BkError(Codes.CONFIG_INVALID, `service ${name} 不能同时设置 command 与 startCommand`,
        { remediation: '二选一：dotEnv 用 command，startupArgs 用 startCommand' })
    if (s.injectionMode !== undefined && !['dotEnv', 'startupArgs'].includes(s.injectionMode))
      throw new BkError(Codes.CONFIG_INVALID, `service ${name} 的 injectionMode 只能是 dotEnv 或 startupArgs`)
    return { name, type: s.type, port_base: s.port_base, command: s.command,
      startCommand: s.startCommand, injectionMode: s.injectionMode,
      app: s.app, dir: s.dir, envs: s.envs, post_allocate: s.post_allocate }
  })
  return {
    project_name: raw.project_name,
    services,
    infra: raw.infra ?? {},
    allocation: raw.allocation,
  }
}
