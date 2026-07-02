import type { ServiceConfig, ServiceType, ResourceNames, InjectionMode } from '../core/types.js'

export interface FrameworkAdapter {
  type: ServiceType
  detect(dir: string): boolean
  defaultInjectionMode: InjectionMode
  defaultStartCommand(svc: ServiceConfig, dir: string): string
  envVars(names: ResourceNames): Record<string, string>
}
