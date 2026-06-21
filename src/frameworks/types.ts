import type { ServiceConfig, ServiceType, ResourceNames } from '../core/types.js'

export interface FrameworkAdapter {
  type: ServiceType
  detect(dir: string): boolean
  defaultStartCommand(svc: ServiceConfig, port?: number): string
  envVars(names: ResourceNames): Record<string, string>
}
