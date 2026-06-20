import type { Ctx, ResourceNames } from '../core/types.js'

export interface ResourceProvider {
  kind: string
  plan(n: number, ctx: Ctx): Partial<ResourceNames>
  probe(n: number, ctx: Ctx): Promise<boolean>     // true=可用, false=撞了(跳号)
  provision(n: number, ctx: Ctx): Promise<void>
  destroy(n: number, ctx: Ctx): Promise<void>
  envVars(n: number, ctx: Ctx): Record<string, string>
}
