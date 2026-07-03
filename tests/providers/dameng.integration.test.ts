import { describe, it, expect, beforeAll } from 'vitest'
import { createDamengProvider } from '../../src/providers/dameng.js'
import type { Ctx } from '../../src/core/types.js'

// 本地接常驻达梦实例：export BK_DM_HOST=127.0.0.1 BK_DM_PORT=5236 BK_DM_USER=SYSDBA BK_DM_PASSWORD=*** 后运行。
// CI 无该环境变量 → 自动跳过，不变红。
const enabled = !!process.env.BK_DM_HOST
const d = describe.runIf(enabled)

let ctx: Ctx
d('dameng provider 集成', () => {
  beforeAll(() => {
    ctx = {
      projectRoot: '/x',
      config: { project_name: 'bkint', services: [],
        infra: { dameng: {
          host: process.env.BK_DM_HOST as string,
          port: Number(process.env.BK_DM_PORT ?? 5236),
          username: process.env.BK_DM_USER ?? 'SYSDBA',
          password: process.env.BK_DM_PASSWORD ?? '',
        } } },
    }
  })

  it('provision 建 schema、probe 复测为 false、destroy 删 schema', async () => {
    const p = createDamengProvider()
    expect(p.plan(7, ctx).dmSchema).toBe('BKINT_7')
    expect(await p.probe(7, ctx)).toBe(true)   // 不存在 → 可分配
    await p.provision(7, ctx)
    expect(await p.probe(7, ctx)).toBe(false)  // 已存在 → 撞了
    await p.destroy(7, ctx)
    expect(await p.probe(7, ctx)).toBe(true)   // 删后 → 又可分配
  })
})
