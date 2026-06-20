import type { ServiceConfig, ServiceType } from '../core/types.js'

export interface FrameworkAdapter {
  type: ServiceType
  detect(dir: string): boolean
  defaultStartCommand(svc: ServiceConfig, port: number): string
}
