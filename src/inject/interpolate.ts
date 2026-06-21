import type { ResourceNames } from '../core/types.js'
import { BkError, Codes } from '../core/errors.js'

const TOKEN = /\{([A-Za-z0-9_-]+)\.port\}/g

function interpolateValue(value: string, names: ResourceNames, svcName: string, key: string): string {
  return value.replace(TOKEN, (_m, target: string) => {
    const port = names.ports?.[target]
    if (port === undefined)
      throw new BkError(Codes.CONFIG_INVALID,
        `service ${svcName} 的 envs.${key} 引用了 {${target}.port}，但找不到该服务的端口`,
        { remediation: '检查服务名拼写，以及目标 service 是否配了 port_base' })
    return String(port)
  })
}

export function interpolateEnvs(
  envs: Record<string, string>, names: ResourceNames, svcName: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(envs)) out[k] = interpolateValue(v, names, svcName, k)
  return out
}
