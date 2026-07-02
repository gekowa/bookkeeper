import type { ServiceConfig, ServiceType, ResourceNames, ResolveContext } from '../core/types.js'

export interface FrameworkAdapter {
  type: ServiceType
  defaultInjectionMode: 'dotEnv' | 'startupArgs'
  detect(dir: string): boolean
  defaultStartCommand(svc: ServiceConfig, rc: ResolveContext): string
  envVars(names: ResourceNames): Record<string, string>
}
