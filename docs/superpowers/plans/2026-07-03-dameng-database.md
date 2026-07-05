# 达梦数据库（DM8）支持 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 BookKeeper 增加达梦 DM8 作为独立可选 infra 类型，让每个 worktree 像领 postgres 库一样「领一个达梦 schema」。

**Architecture:** 达梦是正交 infra 类型，按 SCHEMA 隔离（共享连接用户、连接串恒定，唯一随 worktree 变化的是 schema 名）。新增 `dameng` provider（用官方 `dmdb` npm 包做 CREATE/PROBE/DESTROY）+ 一组类型/映射/注入/展示改动，接入现有「统一注入模型」的 `{infra.*}` 占位符体系。

**Tech Stack:** TypeScript（strict、NodeNext、ESM-only）、达梦官方 npm 包 `dmdb`（v1.0.x，纯 JS、自带 `index.d.ts`）、vitest。

## Global Constraints

- **ESM-only**：所有相对 import 必须带 `.js` 后缀（NodeNext 硬性要求，源文件是 `.ts` 也要 `.js`）。
- **错误处理**：业务错误一律 `throw new BkError(code, message, { remediation })`，code 取自 `src/core/errors.ts` 的 `Codes`（本计划用到 `CONFIG_INVALID`、`INFRA_UNREACHABLE`）。不用裸 `Error`。
- **schema 命名**：`<PROJECT>_N` 全大写（如 `foo` + N=1 → `FOO_1`），由 `schemaName()` 用 `.toUpperCase()` 生成。
- **驱动**：`dmdb` v1.0.49630（纯 JS、无 native binding，`npm install` 无需系统依赖；自带 `index.d.ts`，**不需要** `@types/dmdb`）。`export = dmdb`，靠 `esModuleInterop: true` 用 `import dmdb from 'dmdb'`。
- **幂等**：allocate 重复调用复用既有 Set、不重 provision；destroy 幂等（`DROP SCHEMA ... CASCADE`，schema 不存在不报错）。
- **配置过滤**：`bk list` 展示按当前 `bk_config.yml` 过滤——只显示配置里仍声明的 infra（`config.infra.dameng` 为真才展示达梦行）。
- **mdodb probe SQL 以本地集成测试为准绳**：Task 6 的集成测试（接本机常驻 DM 实例）是 `SCHEMA_EXISTS_SQL` 的验证门；若目标 DM 版本系统目录列名不同，修正该常量一行即可，CI 不受影响（集成测试 env 守卫、无 DM 时跳过）。

## File Structure

| 文件 | 职责 | 动作 |
|------|------|------|
| `src/providers/dameng.ts` | 达梦 provider：plan/probe/provision/destroy（`dmdb` 连接） | 新增 |
| `src/providers/registry.ts` | 按 `infra.dameng` 动态注册 provider | 改 |
| `src/core/types.ts` | `InfraConfig.dameng`、`ResourceNames.dmSchema`、`SetRecord.resources.dameng` | 改 |
| `src/core/allocator.ts` | `ResourceNames ↔ SetRecord.resources` 双向映射 | 改 |
| `src/frameworks/backendEnv.ts` | 产 `BK_DM_SCHEMA` | 改 |
| `src/inject/interpolate.ts` | `{infra.dameng.*}` 占位符 | 改 |
| `src/cli/commands/list.ts` | 展示「达梦 schema」行 | 改 |
| `tests/providers/dameng.test.ts` | provider 单测（plan 命名 + cfg guard） | 新增 |
| `tests/providers/dameng.integration.test.ts` | 接本机 DM 的集成测试（env 守卫） | 新增 |
| `tests/core/allocator.test.ts` | 双向映射测试 | 改 |
| `tests/frameworks/env.test.ts` | `BK_DM_SCHEMA` 测试 | 改 |
| `tests/inject/interpolate.test.ts` | `{infra.dameng.*}` 占位符测试 | 改 |
| `tests/cli/list.test.ts` | 达梦展示测试 | 改 |
| `package.json` | 加 `dmdb` 依赖 | 改 |
| `README.md` / `CHANGELOG.md` | 文档 | 改 |

---

## Task 1: dmdb 依赖 + 达梦 provider（plan/cfg-guard）

**Files:**
- Create: `src/providers/dameng.ts`
- Create: `tests/providers/dameng.test.ts`
- Modify: `src/core/types.ts`（`InfraConfig`、`ResourceNames`、`SetRecord.resources`）
- Modify: `package.json`

**Interfaces:**
- Produces: `createDamengProvider(): ResourceProvider`（`kind: 'dameng'`；`plan` 产 `{ dmSchema }`）；类型 `InfraConfig.dameng`、`ResourceNames.dmSchema`、`SetRecord.resources.dameng`。供后续 Task 2-5 消费。

- [ ] **Step 1: 加 dmdb 依赖**

Run:
```bash
npm install dmdb@1.0.49630
```
Expected: `added 1 package`（纯 JS，无 node-gyp / native 编译）。确认 `package.json` 的 `dependencies` 出现 `"dmdb": "..."`。

- [ ] **Step 2: 扩展类型（`src/core/types.ts`）**

`InfraConfig` 加 `dameng`（与 postgres 平级）：
```ts
export interface InfraConfig {
  postgres?: { host: string; port: number; username: string; password: string }
  redis?: { host: string; port: number; isolation?: RedisIsolation }
  minio?: { endpoint: string; access_key: string; secret_key: string }
  dameng?: { host: string; port: number; username: string; password: string }
}
```
`ResourceNames` 加 `dmSchema`：
```ts
export interface ResourceNames {
  ports: Record<string, number>
  database?: string
  redisPrefix?: string
  redisDb?: number
  bucket?: string
  dmSchema?: string
}
```
`SetRecord.resources` 的 infra 段加 `dameng`：
```ts
  resources: {
    [service: string]: { port: number } | undefined
  } & {
    postgres?: { database: string }
    redis?: { prefix?: string; db?: number }
    minio?: { bucket: string }
    dameng?: { schema: string }
  }
```

- [ ] **Step 3: 写失败测试（`tests/providers/dameng.test.ts`）**

```ts
import { describe, it, expect } from 'vitest'
import { createDamengProvider } from '../../src/providers/dameng.js'
import type { Ctx } from '../../src/core/types.js'

const ctx: Ctx = {
  projectRoot: '/x',
  config: { project_name: 'foo', services: [],
    infra: { dameng: { host: '127.0.0.1', port: 5236, username: 'SYSDBA', password: 'x' } } },
}

describe('dameng provider plan', () => {
  it('产大写 schema 名 <PROJECT>_N', () => {
    const p = createDamengProvider()
    expect(p.plan(1, ctx).dmSchema).toBe('FOO_1')
    expect(p.plan(12, ctx).dmSchema).toBe('FOO_12')
  })
  it('kind = dameng', () => {
    expect(createDamengProvider().kind).toBe('dameng')
  })
})

describe('dameng provider cfg guard', () => {
  it('infra 无 dameng 时 probe 抛 CONFIG_INVALID', async () => {
    const ctxNoDm: Ctx = { projectRoot: '/x', config: { project_name: 'foo', services: [], infra: {} } }
    await expect(createDamengProvider().probe(1, ctxNoDm)).rejects.toThrow(/CONFIG_INVALID|dameng/)
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npx vitest run tests/providers/dameng.test.ts`
Expected: FAIL（`Cannot find module '../../src/providers/dameng.js'`）。

- [ ] **Step 5: 写 provider（`src/providers/dameng.ts`）**

```ts
import dmdb from 'dmdb'
import type { ResourceProvider } from './types.js'
import type { Ctx } from '../core/types.js'
import { BkError, Codes } from '../core/errors.js'

function schemaName(n: number, ctx: Ctx) { return `${ctx.config.project_name}_${n}`.toUpperCase() }
function cfg(ctx: Ctx) {
  const dm = ctx.config.infra.dameng
  if (!dm) throw new BkError(Codes.CONFIG_INVALID, 'infra.dameng 未配置')
  return dm
}
async function withClient<T>(ctx: Ctx, fn: (c: dmdb.Connection) => Promise<T>): Promise<T> {
  const dm = cfg(ctx)
  let c: dmdb.Connection
  try {
    c = await dmdb.getConnection({
      user: dm.username, password: dm.password, connectString: `${dm.host}:${dm.port}`,
    })
  } catch (e: any) {
    throw new BkError(Codes.INFRA_UNREACHABLE, `无法连接达梦 (${dm.host}:${dm.port})：${e.message}`,
      { recoverable: false, remediation: '你的本地达梦数据库起了吗？' })
  }
  try { return await fn(c) } finally { await c.close() }
}

// schema 不存在 → true(可分配)；存在 → false(撞了→跳号)。系统目录列名以本机集成测试为准绳。
const SCHEMA_EXISTS_SQL = `SELECT 1 FROM SYSOBJECTS WHERE TYPE$ = 'SCH' AND NAME = ?`

export function createDamengProvider(): ResourceProvider {
  return {
    kind: 'dameng',
    plan: (n, ctx) => ({ dmSchema: schemaName(n, ctx) }),
    probe: (n, ctx) => withClient(ctx, async (c) => {
      const r = await c.execute(SCHEMA_EXISTS_SQL, [schemaName(n, ctx)])
      return (r.rows?.length ?? 0) === 0
    }),
    provision: (n, ctx) => withClient(ctx, async (c) => {
      await c.execute(`CREATE SCHEMA "${schemaName(n, ctx)}"`)
    }),
    destroy: (n, ctx) => withClient(ctx, async (c) => {
      await c.execute(`DROP SCHEMA "${schemaName(n, ctx)}" CASCADE`)
    }),
  }
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/providers/dameng.test.ts`
Expected: PASS（3 个用例）。`dmdb` 纯 JS，单元测试 import 它无需连接即可加载。

- [ ] **Step 7: typecheck + commit**

Run: `npm run typecheck`（应通过；`dmdb.Connection` 借 `esModuleInterop` 可作类型用）
```bash
git add src/providers/dameng.ts src/core/types.ts tests/providers/dameng.test.ts package.json package-lock.json
git commit -m "feat(providers): 达梦(DM8) provider——schema 隔离 + dmdb 驱动

新增 infra.dameng 可选类型，plan/probe/provision/destroy；
ResourceNames.dmSchema / SetRecord.resources.dameng 类型扩展。
probe/destroy 的目录 SQL 以本机集成测试为准（见 Task 6）。"
```

---

## Task 2: allocator 双向映射 + registry 注册

**Files:**
- Modify: `src/core/allocator.ts`（`buildSetRecord` + `setToResourceNames`）
- Modify: `src/providers/registry.ts`
- Modify: `tests/core/allocator.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ResourceNames.dmSchema`、`SetRecord.resources.dameng`、`createDamengProvider`。
- Produces: 分配流程正确把 `dmSchema` 持久化进 `SetRecord.resources.dameng`、并能反向还原；`infra.dameng` 声明时 provider 进 active 列表。

- [ ] **Step 1: 写失败测试（追加到 `tests/core/allocator.test.ts`）**

文件顶部 import 行改为：
```ts
import { resolveSet, provisionSet, buildSetRecord, setToResourceNames } from '../../src/core/allocator.js'
```
文件末尾追加：
```ts
describe('达梦资源映射', () => {
  it('buildSetRecord: dmSchema → resources.dameng', () => {
    const rec = buildSetRecord(
      { ports: { api: 10001 }, dmSchema: 'FOO_2' },
      { worktree: '/wt', branch: 'x' },
    )
    expect(rec.resources.dameng).toEqual({ schema: 'FOO_2' })
  })
  it('setToResourceNames: resources.dameng → dmSchema（且不计入端口遍历）', () => {
    const names = setToResourceNames({
      status: 'allocated', owner: null, created_at: 'x',
      resources: { api: { port: 10001 }, dameng: { schema: 'FOO_3' } },
    })
    expect(names.dmSchema).toBe('FOO_3')
    expect(names.ports).toEqual({ api: 10001 })  // dameng 不被误当服务端口
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/allocator.test.ts -t "达梦资源映射"`
Expected: FAIL（`rec.resources.dameng` 为 undefined / `names.dmSchema` 为 undefined）。

- [ ] **Step 3: 加双向映射（`src/core/allocator.ts`）**

`buildSetRecord` 在 `if (names.bucket)` 之后加一行：
```ts
  if (names.dmSchema) resources.dameng = { schema: names.dmSchema }
```
（即 `if (names.bucket) resources.minio = { bucket: names.bucket }` 之后、`return {...}` 之前）

`setToResourceNames`：把端口遍历的跳过列表加 `'dameng'`：
```ts
    if (svc === 'postgres' || svc === 'redis' || svc === 'minio' || svc === 'dameng') continue
```
并在 return 对象里加：
```ts
    dmSchema: set.resources.dameng?.schema,
```
（与 `bucket: set.resources.minio?.bucket,` 同级）

- [ ] **Step 4: registry 注册（`src/providers/registry.ts`）**

import 段加：
```ts
import { createDamengProvider } from './dameng.js'
```
`activeProviders` 在 minio 行之后加：
```ts
  if (ctx.config.infra.dameng) list.push(createDamengProvider())
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/core/allocator.test.ts`
Expected: PASS（含新增 2 个达梦映射用例）。

- [ ] **Step 6: typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/core/allocator.ts src/providers/registry.ts tests/core/allocator.test.ts
git commit -m "feat(core): 达梦资源双向映射 + registry 动态注册"
```

---

## Task 3: 后端注入 BK_DM_SCHEMA

**Files:**
- Modify: `src/frameworks/backendEnv.ts`
- Modify: `tests/frameworks/env.test.ts`

**Interfaces:**
- Consumes: `ResourceNames.dmSchema`（Task 1）。
- Produces: 后端框架默认 `BK_*` 集在分配了达梦 schema 时产出 `BK_DM_SCHEMA=<大写名>`。

- [ ] **Step 1: 写失败测试（追加到 `tests/frameworks/env.test.ts`）**

文件末尾追加：
```ts
describe('dameng BK_DM_SCHEMA', () => {
  it('dmSchema 产 BK_DM_SCHEMA', () => {
    expect(adapterFor('django').envVars({ ports: {}, dmSchema: 'FOO_2' }))
      .toEqual({ BK_DM_SCHEMA: 'FOO_2' })
  })
  it('postgres + dameng 共存时两者都产出', () => {
    expect(adapterFor('springboot').envVars({ ports: {}, database: 'foo_2', dmSchema: 'FOO_2' }))
      .toEqual({ BK_DB_NAME: 'foo_2', BK_DM_SCHEMA: 'FOO_2' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/frameworks/env.test.ts -t "BK_DM_SCHEMA"`
Expected: FAIL（`BK_DM_SCHEMA` 不在结果对象里）。

- [ ] **Step 3: 改 `src/frameworks/backendEnv.ts`**

在 `if (names.bucket) out.BK_MINIO_BUCKET = names.bucket` 之后加一行：
```ts
  if (names.dmSchema) out.BK_DM_SCHEMA = names.dmSchema
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/frameworks/env.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/frameworks/backendEnv.ts tests/frameworks/env.test.ts
git commit -m "feat(inject): 后端默认 envs 产 BK_DM_SCHEMA"
```

---

## Task 4: 占位符 {infra.dameng.*}

**Files:**
- Modify: `src/inject/interpolate.ts`
- Modify: `tests/inject/interpolate.test.ts`

**Interfaces:**
- Consumes: `ctx.config.infra.dameng`（静态）+ `names.dmSchema`（动态）。
- Produces: 用户可在 `envs`/`command` 用 `{infra.dameng.schema}` / `{infra.dameng.host}` / `.port` / `.username` / `.password`；引用未声明达梦 → `CONFIG_INVALID`。

- [ ] **Step 1: 写失败测试（追加到 `tests/inject/interpolate.test.ts` 的 `buildInterpValues` describe）**

在「redis isolation=key_prefix」用例之后追加：
```ts
  it('dameng: {infra.dameng.schema} 与静态字段（含密钥）', () => {
    const ctxDm: Ctx = { projectRoot: '/x', config: { project_name: 'p', infra: {
      dameng: { host: 'localhost', port: 5236, username: 'SYSDBA', password: 'dmpw' } } } }
    const vals = buildInterpValues(ctxDm, { ports: {}, dmSchema: 'P_2' }, svc)
    expect(interpolateCommand(
      '{infra.dameng.schema}|{infra.dameng.host}|{infra.dameng.port}|{infra.dameng.username}|{infra.dameng.password}',
      vals, '',
    )).toBe('P_2|localhost|5236|SYSDBA|dmpw')
  })
  it('dameng 未声明时 {infra.dameng.schema} → CONFIG_INVALID', () => {
    const empty: Ctx = { projectRoot: '/x', config: { project_name: 'p', infra: {} } }
    const vals = buildInterpValues(empty, { ports: {} }, svc)
    expect(() => interpolateCommand('{infra.dameng.schema}', vals, '')).toThrow(/CONFIG_INVALID|dameng/)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/inject/interpolate.test.ts -t "dameng"`
Expected: FAIL（`{infra.dameng.schema}` 解析为「未知占位符格式」报错，或断言不匹配）。

- [ ] **Step 3: 改 `src/inject/interpolate.ts`**

`InterpValues.infra` 类型加 `dameng` 段：
```ts
  infra: {
    postgres?: { database?: string; host?: string; port?: number; username?: string; password?: string }
    redis?: { db?: number; prefix?: string; host?: string; port?: number }
    minio?: { bucket?: string; endpoint?: string; access_key?: string; secret_key?: string }
    dameng?: { schema?: string; host?: string; port?: number; username?: string; password?: string }
  }
```
`lookup` 里 infra 正则加 `dameng`，并把它加入联合类型断言：
```ts
  if ((m = tok.match(/^infra\.(postgres|redis|minio|dameng)\.(\w+)$/))) {
    const sec = v.infra[m[1] as 'postgres' | 'redis' | 'minio' | 'dameng']
    const val = sec?.[m[2] as keyof typeof sec]
    if (val === undefined) bail(v.svcName, tok, `${m[1]}.${m[2]} 不可用（infra 未声明或资源未分配）`)
    return String(val)
  }
```
`buildInterpValues` 的 return.infra 加 `dameng` 段（在 minio 段之后）：
```ts
      dameng: (i.dameng || names.dmSchema) ? {
        schema: names.dmSchema,
        host: i.dameng?.host, port: i.dameng?.port,
        username: i.dameng?.username, password: i.dameng?.password,
      } : undefined,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/inject/interpolate.test.ts`
Expected: PASS（含新增 2 个 dameng 用例，且现有用例不回归）。

- [ ] **Step 5: typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/inject/interpolate.ts tests/inject/interpolate.test.ts
git commit -m "feat(inject): {infra.dameng.*} 占位符（schema + 静态连接字段）"
```

---

## Task 5: bk list 展示达梦 schema

**Files:**
- Modify: `src/cli/commands/list.ts`（`renderSet`）
- Modify: `tests/cli/list.test.ts`

**Interfaces:**
- Consumes: `config.infra.dameng` + `r.resources.dameng`（Task 1/2）。
- Produces: `bk list` 在声明达梦且已分配时显示 `    - 达梦 schema: FOO_1`；配置过滤沿用现有约定。

- [ ] **Step 1: 写失败测试（追加到 `tests/cli/list.test.ts`）**

文件顶部 `config` 加 `dameng`：
```ts
const config: ProjectConfig = {
  project_name: 'foo',
  services: [{ name: 'backend', type: 'django' }],
  infra: {
    postgres: { host: 'h', port: 5432, username: 'u', password: 'p' },
    minio: { endpoint: 'e', access_key: 'a', secret_key: 's' },
    dameng: { host: '127.0.0.1', port: 5236, username: 'SYSDBA', password: 'p' },
  },
}
```
`state` 的 Set 1 resources 加 `dameng`：
```ts
  '1': { status: 'allocated', owner: { worktree: '/wt/foo.x', branch: 'x' },
    resources: { backend: { port: 10001 }, postgres: { database: 'foo_1' }, minio: { bucket: 'foo-1' }, dameng: { schema: 'FOO_1' } }, created_at: 'x' },
```
文件末尾追加：
```ts
  it('含 dameng infra 时显示「达梦 schema」行', () => {
    const out = renderList(state, 'foo', config)
    expect(out).toContain('达梦 schema: FOO_1')
  })
  it('infra 不含 dameng 时，不显示达梦行（即使已持久化）', () => {
    const noDm: ProjectConfig = { ...config, infra: { postgres: config.infra.postgres } }
    const out = renderList(state, 'foo', noDm)
    expect(out).not.toContain('达梦 schema')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/cli/list.test.ts -t "达梦"`
Expected: FAIL（不含「达梦 schema: FOO_1」）。

- [ ] **Step 3: 改 `src/cli/commands/list.ts`**

`renderSet` 在 minio 行之后加：
```ts
  if (config.infra.dameng && r.resources.dameng) lines.push(`    - 达梦 schema: ${r.resources.dameng.schema}`)
```
（即 `if (config.infra.minio && r.resources.minio) ...` 之后、`return lines.join('\n')` 之前）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/cli/list.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/cli/commands/list.ts tests/cli/list.test.ts
git commit -m "feat(list): bk list 展示达梦 schema 行（按 config.infra.dameng 过滤）"
```

---

## Task 6: 集成测试（接本机常驻 DM 实例）

**Files:**
- Create: `tests/providers/dameng.integration.test.ts`

**Interfaces:**
- Consumes: `createDamengProvider`（Task 1）。这是 `SCHEMA_EXISTS_SQL` 与 CREATE/DROP SQL 的真实验证门。

- [ ] **Step 1: 写集成测试（env 守卫，无 DM 时跳过、不变红）**

```ts
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
```

- [ ] **Step 2: 确认无 env 时跳过**

Run: `npx vitest run tests/providers/dameng.integration.test.ts`
Expected: 无 `BK_DM_HOST` 时显示 `skipped`（不执行、不失败）。

- [ ] **Step 3: （可选，需本机 DM）本地跑通验证 SQL**

Run（替换为本机真实连接信息）:
```bash
BK_DM_HOST=127.0.0.1 BK_DM_PORT=5236 BK_DM_USER=SYSDBA BK_DM_PASSWORD='你的密码' \
  npx vitest run tests/providers/dameng.integration.test.ts
```
Expected: PASS。**若 probe 的 `SCHEMA_EXISTS_SQL` 因目标 DM 版本目录列名不同而失败**，修正 `src/providers/dameng.ts` 的 `SCHEMA_EXISTS_SQL` 常量（仅一行 SQL），重跑直至通过。这是该 SQL 的唯一验证门。

- [ ] **Step 4: typecheck + commit**

Run: `npm run typecheck`
```bash
git add tests/providers/dameng.integration.test.ts
git commit -m "test(providers): 达梦集成测试（接本机常驻实例，env 守卫、CI 跳过）"
```

---

## Task 7: 文档（README + CHANGELOG）

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README infra 配置块加 dameng（`## 配置` 的 infra: 段，minio 之后）**

在 `minio:` 块之后、` ``` ` 闭合之前加：
```yaml
  dameng:                # 可选；达梦 DM8。所有 worktree 共用同一连接用户，按 SCHEMA 隔离
    host: 127.0.0.1
    port: 5236
    username: SYSDBA
    password: "***"
```

- [ ] **Step 2: README 占位符表加 dameng 行（`### 占位符语法` 的表格，minio 行之后）**

在 `| {infra.minio.<字段>} ... |` 行之后加：
```markdown
| `{infra.dameng.<字段>}` | 达梦资源 | `schema` / `host` / `port` / `username` / `password` |
```

- [ ] **Step 3: README 配置注入段补 BK_DM_SCHEMA（后端 `.env` 示例 + 说明）**

把「配置注入」段后端 `.env` 示例更新为含达梦（仅当配了达梦时才写）：
```
# >>> bk managed >>>
BK_DB_NAME=foo_2
BK_REDIS_DB=2
BK_MINIO_BUCKET=foo-2
BK_DM_SCHEMA=FOO_2          # 仅 infra 声明达梦时
# <<< bk managed <<<
```
并在「后端只写动态隔离标识」一句后补：「达梦的隔离标识是 schema 名（`BK_DM_SCHEMA`，大写）；所有 worktree 共用同一连接用户、连接串恒定，应用据此设置当前 schema（如 Spring Boot `spring.datasource.hikari.schema=${BK_DM_SCHEMA}`）。」

- [ ] **Step 4: README Spring Boot 段补达梦 yml 示例（`### Spring Boot` 的 yaml 块）**

在现有 yaml 块的 datasource 下补 schema 引用（示意，项目按自身 yml 结构调整）：
```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/${BK_DB_NAME}
    hikari:
      schema: ${BK_DM_SCHEMA}   # 达梦：当前 schema（仅用达梦时）
  data:
    redis:
      database: ${BK_REDIS_DB}
```

- [ ] **Step 5: CHANGELOG `[未发布]` 的 Added 追加条目**

在 `### Added` 列表末尾追加：
```markdown
- **达梦数据库（DM8）支持**：新增 `infra.dameng` 可选 infra 类型，按 SCHEMA 隔离（所有 worktree 共用
  同一连接用户、各自建独立 schema `<PROJECT>_N` 全大写）。后端注入 `BK_DM_SCHEMA`；占位符新增
  `{infra.dameng.*}`。驱动用官方 `dmdb` npm 包（纯 JS）。集成测试接本机常驻实例（env 守卫、CI 跳过）。
```

- [ ] **Step 6: 全量回归 + commit**

Run: `npm test && npm run typecheck`
Expected: 全部测试 PASS、typecheck 通过（无 `BK_DM_HOST` 时集成测试自动跳过）。
```bash
git add README.md CHANGELOG.md
git commit -m "docs: 达梦(DM8) 支持——README 配置/注入/占位符 + CHANGELOG"
```

---

## Self-Review（写计划后核对 spec）

**Spec 覆盖核对：**
- 配置 schema（`infra.dameng`）→ Task 1 Step 2 + Task 7 Step 1 ✓
- 资源命名（大写 `<PROJECT>_N`）→ Task 1 Step 5（`schemaName`）✓
- Provider plan/probe/provision/destroy → Task 1 ✓
- 类型与 State（`ResourceNames.dmSchema` / `SetRecord.resources.dameng` / `InfraConfig.dameng`）→ Task 1 Step 2 ✓
- allocator 双向映射（spec「影响的文件」未显式列出，本计划补上）→ Task 2 ✓
- registry 注册 → Task 2 Step 4 ✓
- 环境变量 `BK_DM_SCHEMA` → Task 3 ✓
- 占位符 `{infra.dameng.*}` → Task 4 ✓
- list 展示 → Task 5 ✓
- 测试（单测/流程/集成）→ Task 1/2/3/4/5/6 ✓（流程测试复用 fakeProvider，spec 已说明无需为达梦重复）
- 依赖 dmdb → Task 1 Step 1 ✓
- README/CHANGELOG → Task 7 ✓

**类型一致性核对：** `dmSchema`（Task 1 定义）在 Task 2（`names.dmSchema`/`resources.dameng.schema`）、Task 3（`names.dmSchema`）、Task 4（`names.dmSchema`/`{infra.dameng.schema}`）、Task 5（`r.resources.dameng.schema`）中命名一致 ✓。`createDamengProvider` / `kind: 'dameng'` 跨 Task 一致 ✓。
