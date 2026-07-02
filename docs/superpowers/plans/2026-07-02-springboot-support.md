# SpringBoot service 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 bk 增加 `springboot` service 类型，用"启动参数注入"（非 `.env`）向 SpringBoot 进程传递每套 worktree 的隔离资源。

**Architecture:** 引入 `injectionMode`（`dotEnv`/`startupArgs`，按 type 缺省、可覆盖）作为注入载体总开关。新增通用 token 解析器（`{self.port}`/`{db.name}`/`{infra.postgres.*}` 等），可用于 `startCommand` 数组元素与 `envs` 值。`startupArgs` 模式下 `startCommand`（命令行参数/`-D` 系统属性）与 `envs`（进程环境变量）分工，launch 期按目标 shell 渲染。springboot 无默认启动命令，必须配 `startCommand`。

**Tech Stack:** TypeScript (ESM, NodeNext)、vitest、execa、commander、yaml。测试用 `npm test`（`vitest run`）。

## Global Constraints

- Node ≥ 20；ESM，import 路径带 `.js` 后缀。
- 错误一律 `throw new BkError(Codes.CONFIG_INVALID, msg, { remediation })`；`Codes` 在 `src/core/errors.ts`，不新增错误码。
- 注释与用户可见文案用中文，与现有代码风格一致。
- dotEnv 现有路径（django/fastapi/vite/arq/celery）行为**零回归**：默认启动命令字符串、`.env` 写入内容都不得改变。
- 每个 task 结尾提交；提交信息用中文，结尾附：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 运行单个测试文件：`npx vitest run tests/<path>`。

---

### Task 1: 配置 schema 扩展（ServiceType/ServiceConfig/load 校验）

**Files:**
- Modify: `src/core/types.ts:1` (ServiceType)、`src/core/types.ts:4-13` (ServiceConfig)
- Modify: `src/config/load.ts:11-18`
- Test: `tests/config/load.test.ts`

**Interfaces:**
- Produces: `ServiceType` 含 `'springboot'`；`ServiceConfig.injectionMode?: 'dotEnv' | 'startupArgs'`；`ServiceConfig.startCommand?: string[]`。`loadConfig` 透传并校验二者。

- [ ] **Step 1: 写失败测试**

在 `tests/config/load.test.ts` 末尾新增（文件已有 `loadConfig` + 临时目录写 yml 的既有用例，沿用其 helper；若无则参考下方自带 helper）：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { loadConfig } from '../../src/config/load.js'

function withYml(body: string, fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'bkcfg-'))
  try { writeFileSync(join(root, 'bk_config.yml'), body); fn(root) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

describe('loadConfig springboot 字段', () => {
  it('透传 injectionMode 与 startCommand', () => {
    withYml(`project_name: foo
services:
  api:
    type: springboot
    port_base: 10200
    dir: api
    injectionMode: startupArgs
    startCommand:
      - mvn
      - spring-boot:run
`, (root) => {
      const c = loadConfig(root)
      const svc = c.services.find(s => s.name === 'api')!
      expect(svc.type).toBe('springboot')
      expect(svc.injectionMode).toBe('startupArgs')
      expect(svc.startCommand).toEqual(['mvn', 'spring-boot:run'])
    })
  })
  it('command 与 startCommand 同时给 → CONFIG_INVALID', () => {
    withYml(`project_name: foo
services:
  api:
    type: springboot
    command: mvn spring-boot:run
    startCommand: [mvn, spring-boot:run]
`, (root) => expect(() => loadConfig(root)).toThrow(/CONFIG_INVALID|command.*startCommand|同时/))
  })
  it('startCommand 非字符串数组 → CONFIG_INVALID', () => {
    withYml(`project_name: foo
services:
  api:
    type: springboot
    startCommand: "mvn spring-boot:run"
`, (root) => expect(() => loadConfig(root)).toThrow(/CONFIG_INVALID|startCommand/))
  })
  it('injectionMode 非法值 → CONFIG_INVALID', () => {
    withYml(`project_name: foo
services:
  api:
    type: springboot
    injectionMode: weird
`, (root) => expect(() => loadConfig(root)).toThrow(/CONFIG_INVALID|injectionMode/))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/config/load.test.ts`
Expected: FAIL（新字段未透传 / 未校验）

- [ ] **Step 3: 改 types.ts**

`src/core/types.ts` 第 1 行：

```ts
export type ServiceType = 'django' | 'fastapi' | 'vite' | 'arq' | 'celery' | 'springboot'
```

`ServiceConfig` 接口内新增两字段：

```ts
export interface ServiceConfig {
  name: string
  type: ServiceType
  port_base?: number
  command?: string
  startCommand?: string[]
  injectionMode?: 'dotEnv' | 'startupArgs'
  app?: string
  dir?: string
  envs?: Record<string, string>
  post_allocate?: string
}
```

- [ ] **Step 4: 改 load.ts**

`src/config/load.ts`，在现有 `envs` 校验（第 15-16 行）之后、`return {...}`（第 17 行）之前插入校验，并在返回对象里加字段：

```ts
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
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/config/load.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/core/types.ts src/config/load.ts tests/config/load.test.ts
git commit -m "feat(config): 增加 springboot type 与 injectionMode/startCommand 字段

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `namesFromSet`（SetRecord → ResourceNames 反向映射）

**Files:**
- Modify: `src/core/allocator.ts`（在 `buildSetRecord` 之后追加）
- Test: `tests/core/allocator.test.ts`

**Interfaces:**
- Produces: `namesFromSet(set: SetRecord): ResourceNames`——把已落地的 `set.resources` 反解为 `ResourceNames`（供 launch 期构造 ResolveContext）。

- [ ] **Step 1: 写失败测试**

在 `tests/core/allocator.test.ts` 末尾追加：

```ts
import { namesFromSet } from '../../src/core/allocator.js'
import type { SetRecord } from '../../src/core/types.js'

describe('namesFromSet', () => {
  it('从 resources 反解出 ports/database/redis/bucket', () => {
    const set: SetRecord = { status: 'allocated', owner: { worktree: '/w', branch: 'b' },
      resources: { backend: { port: 10002 }, frontend: { port: 10102 },
        postgres: { database: 'foo_2' }, redis: { db: 2 }, minio: { bucket: 'foo-2' } },
      created_at: 't' }
    expect(namesFromSet(set)).toEqual({
      ports: { backend: 10002, frontend: 10102 },
      database: 'foo_2', redisPrefix: undefined, redisDb: 2, bucket: 'foo-2',
    })
  })
  it('无 infra 资源时只出 ports', () => {
    const set: SetRecord = { status: 'allocated', owner: null,
      resources: { api: { port: 10200 } }, created_at: 't' }
    expect(namesFromSet(set)).toEqual({ ports: { api: 10200 } })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/allocator.test.ts`
Expected: FAIL with "namesFromSet is not a function"

- [ ] **Step 3: 实现**

`src/core/allocator.ts` 末尾追加（`SetRecord` 已在文件顶部 import 的 types 里）：

```ts
const INFRA_KEYS = new Set(['postgres', 'redis', 'minio'])

export function namesFromSet(set: SetRecord): ResourceNames {
  const ports: Record<string, number> = {}
  for (const [k, v] of Object.entries(set.resources)) {
    if (!INFRA_KEYS.has(k) && v && typeof v === 'object' && 'port' in v)
      ports[k] = (v as { port: number }).port
  }
  const names: ResourceNames = { ports }
  if (set.resources.postgres) names.database = set.resources.postgres.database
  if (set.resources.redis) {
    names.redisPrefix = set.resources.redis.prefix
    names.redisDb = set.resources.redis.db
  }
  if (set.resources.minio) names.bucket = set.resources.minio.bucket
  return names
}
```

确认文件顶部已 import `ResourceNames`（若无则加入 `import type { ..., ResourceNames } from './types.js'`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/allocator.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/allocator.ts tests/core/allocator.test.ts
git commit -m "feat(core): namesFromSet 反解 SetRecord 为 ResourceNames

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 通用 token 解析器（扩展 interpolate）

**Files:**
- Modify: `src/core/types.ts`（加 `ResolveContext`）
- Rewrite: `src/inject/interpolate.ts`
- Modify caller: `src/cli/commands/allocate.ts:24-36`（`buildDirEnvs` 改用新签名）
- Test: `tests/inject/interpolate.test.ts`

**Interfaces:**
- Consumes: `ResourceNames`、`InfraConfig`、`ServiceConfig`。
- Produces: `ResolveContext = { self: ServiceConfig; names: ResourceNames; infra: InfraConfig }`；`resolveTokens(value: string, rc: ResolveContext, where: string): string`；`interpolateEnvs(envs: Record<string,string>, rc: ResolveContext): Record<string,string>`（签名变了：由 `(envs, names, svcName)` 改为 `(envs, rc)`）。

- [ ] **Step 1: 写失败测试**

把 `tests/inject/interpolate.test.ts` 整体替换为：

```ts
import { describe, it, expect } from 'vitest'
import { interpolateEnvs, resolveTokens } from '../../src/inject/interpolate.js'
import type { ResolveContext, ServiceConfig } from '../../src/core/types.js'

const self: ServiceConfig = { name: 'api', type: 'springboot', port_base: 10200 }
const rc: ResolveContext = {
  self,
  names: { ports: { api: 10202, backend: 10001 }, database: 'foo_2', redisDb: 2, bucket: 'foo-2' },
  infra: { postgres: { host: 'localhost', port: 5432, username: 'pg', password: 'sec' },
    redis: { host: 'localhost', port: 6379 }, minio: { endpoint: 'localhost:9000', access_key: 'ak', secret_key: 'sk' } },
}

describe('resolveTokens', () => {
  it('{self.port} 与 {port} 别名都解析本 service 端口', () => {
    expect(resolveTokens('{self.port}', rc, 'x')).toBe('10202')
    expect(resolveTokens('{port}', rc, 'x')).toBe('10202')
  })
  it('{service.port} 解析指定 service', () =>
    expect(resolveTokens('{backend.port}', rc, 'x')).toBe('10001'))
  it('{db.name}/{redis.db}/{minio.bucket}', () => {
    expect(resolveTokens('{db.name}', rc, 'x')).toBe('foo_2')
    expect(resolveTokens('{redis.db}', rc, 'x')).toBe('2')
    expect(resolveTokens('{minio.bucket}', rc, 'x')).toBe('foo-2')
  })
  it('{infra.postgres.*}', () => {
    expect(resolveTokens('jdbc:postgresql://{infra.postgres.host}:{infra.postgres.port}/{db.name}', rc, 'x'))
      .toBe('jdbc:postgresql://localhost:5432/foo_2')
    expect(resolveTokens('{infra.postgres.password}', rc, 'x')).toBe('sec')
  })
  it('未知 service 端口 → CONFIG_INVALID', () =>
    expect(() => resolveTokens('{nope.port}', rc, 'x')).toThrow(/CONFIG_INVALID|nope/))
  it('infra 缺项 → CONFIG_INVALID', () => {
    const rc2: ResolveContext = { self, names: { ports: {} }, infra: {} }
    expect(() => resolveTokens('{infra.postgres.host}', rc2, 'x')).toThrow(/CONFIG_INVALID|infra/)
  })
  it('无法识别的 token → CONFIG_INVALID', () =>
    expect(() => resolveTokens('{bogus.thing}', rc, 'x')).toThrow(/CONFIG_INVALID/))
})

describe('interpolateEnvs', () => {
  it('对每个值插值', () =>
    expect(interpolateEnvs({ URL: 'http://localhost:{backend.port}/api', P: '{infra.postgres.password}' }, rc))
      .toEqual({ URL: 'http://localhost:10001/api', P: 'sec' }))
  it('无 token 原样返回', () =>
    expect(interpolateEnvs({ X: 'plain', Y: '' }, rc)).toEqual({ X: 'plain', Y: '' }))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/inject/interpolate.test.ts`
Expected: FAIL（`resolveTokens` 未导出 / 新 token 不支持）

- [ ] **Step 3: 加 ResolveContext 到 types.ts**

`src/core/types.ts`，在 `ResourceNames` 接口之后追加：

```ts
export interface ResolveContext {
  self: ServiceConfig
  names: ResourceNames
  infra: InfraConfig
}
```

- [ ] **Step 4: 重写 interpolate.ts**

整体替换 `src/inject/interpolate.ts`：

```ts
import type { ResolveContext } from '../core/types.js'
import { BkError, Codes } from '../core/errors.js'

const TOKEN = /\{([^}]+)\}/g
const REMEDIATION = '检查 token 拼写、目标 service 是否配 port_base、infra 是否配了该项'

function fail(where: string, expr: string, why: string): never {
  throw new BkError(Codes.CONFIG_INVALID, `${where} 引用了 {${expr}}，${why}`, { remediation: REMEDIATION })
}

function portOf(name: string, rc: ResolveContext, where: string, expr: string): string {
  const p = rc.names.ports?.[name]
  if (p === undefined) fail(where, expr, `但找不到 service ${name} 的端口`)
  return String(p)
}

const GROUP = new Set(['db', 'redis', 'minio', 'infra', 'self'])

function resolveOne(expr: string, rc: ResolveContext, where: string): string {
  if (expr === 'port' || expr === 'self.port') return portOf(rc.self.name, rc, where, expr)
  const svc = expr.match(/^([A-Za-z0-9_-]+)\.port$/)
  if (svc && !GROUP.has(svc[1])) return portOf(svc[1], rc, where, expr)
  if (expr === 'db.name') { if (!rc.names.database) fail(where, expr, '但本套未分配数据库'); return rc.names.database }
  if (expr === 'redis.db') { if (rc.names.redisDb === undefined) fail(where, expr, '但本套未用 db_number 隔离'); return String(rc.names.redisDb) }
  if (expr === 'redis.prefix') { if (!rc.names.redisPrefix) fail(where, expr, '但本套未用 key_prefix 隔离'); return rc.names.redisPrefix }
  if (expr === 'minio.bucket') { if (!rc.names.bucket) fail(where, expr, '但本套未分配桶'); return rc.names.bucket }
  const infra = expr.match(/^infra\.(postgres|redis|minio)\.([A-Za-z_]+)$/)
  if (infra) {
    const grp = (rc.infra as Record<string, Record<string, unknown> | undefined>)[infra[1]]
    const v = grp?.[infra[2]]
    if (v === undefined || v === null) fail(where, expr, `但 infra.${infra[1]}.${infra[2]} 未配置`)
    return String(v)
  }
  fail(where, expr, '无法识别该 token')
}

export function resolveTokens(value: string, rc: ResolveContext, where: string): string {
  return value.replace(TOKEN, (_m, expr: string) => resolveOne(expr.trim(), rc, where))
}

export function interpolateEnvs(envs: Record<string, string>, rc: ResolveContext): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(envs))
    out[k] = resolveTokens(v, rc, `service ${rc.self.name} 的 envs.${k}`)
  return out
}
```

- [ ] **Step 5: 改 allocate.ts 的 buildDirEnvs 调用点**

`src/cli/commands/allocate.ts` 的 `buildDirEnvs`（第 24-36 行）改为构造 `rc` 传入。整体替换该函数为：

```ts
export function buildDirEnvs(ctx: Ctx, names: ResourceNames): Map<string, Record<string, string>> {
  const byDir = new Map<string, Record<string, string>>()
  for (const svc of ctx.config.services) {
    const rc = { self: svc, names, infra: ctx.config.infra }
    const vars = {
      ...adapterFor(svc.type).envVars(names),
      ...interpolateEnvs(svc.envs ?? {}, rc),
    }
    if (Object.keys(vars).length === 0) continue
    const dir = svc.dir ?? '.'
    byDir.set(dir, { ...(byDir.get(dir) ?? {}), ...vars })
  }
  return byDir
}
```

（Task 8 会再补 startupArgs 跳过逻辑；本 task 仅适配新签名。）

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/inject/interpolate.test.ts tests/cli/allocate.flow.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/core/types.ts src/inject/interpolate.ts src/cli/commands/allocate.ts tests/inject/interpolate.test.ts
git commit -m "feat(inject): 通用 token 解析器（self/db/redis/minio/infra）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: FrameworkAdapter 接口重构（defaultStartCommand 去冗余 port + defaultInjectionMode）

**Files:**
- Modify: `src/frameworks/types.ts`
- Modify: `src/frameworks/django.ts`、`fastapi.ts`、`vite.ts`、`arq.ts`、`celery.ts`
- Modify: `src/frameworks/registry.ts`（加 `injectionModeFor`）
- Modify caller: `src/launch/index.ts:16-35`（`buildLaunchSpecs` 构造 rc 调新签名）
- Test: `tests/frameworks/command.test.ts`

**Interfaces:**
- Consumes: `ResolveContext`（Task 3）、`namesFromSet`（Task 2）。
- Produces: `FrameworkAdapter.defaultInjectionMode: 'dotEnv' | 'startupArgs'`；`defaultStartCommand(svc: ServiceConfig, rc: ResolveContext): string`；`injectionModeFor(svc: ServiceConfig): 'dotEnv' | 'startupArgs'`。

- [ ] **Step 1: 改测试为新签名（含新失败用例）**

整体替换 `tests/frameworks/command.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { adapterFor, injectionModeFor } from '../../src/frameworks/registry.js'
import type { ResolveContext, ServiceConfig } from '../../src/core/types.js'

const rc = (svc: ServiceConfig, ports: Record<string, number>): ResolveContext =>
  ({ self: svc, names: { ports }, infra: {} })

describe('defaultStartCommand', () => {
  it('django', () => {
    const s: ServiceConfig = { name: 'b', type: 'django', port_base: 10000 }
    expect(adapterFor('django').defaultStartCommand(s, rc(s, { b: 10002 })))
      .toBe('uv run python manage.py runserver 0.0.0.0:10002')
  })
  it('fastapi 用 app 字段', () => {
    const s: ServiceConfig = { name: 'b', type: 'fastapi', port_base: 10000, app: 'app.main:app' }
    expect(adapterFor('fastapi').defaultStartCommand(s, rc(s, { b: 10002 })))
      .toBe('uv run uvicorn app.main:app --port 10002')
  })
  it('vite', () => {
    const s: ServiceConfig = { name: 'f', type: 'vite', port_base: 10100 }
    expect(adapterFor('vite').defaultStartCommand(s, rc(s, { f: 10102 })))
      .toBe('npm run dev -- --port 10102 --strictPort')
  })
  it('arq 用 app 字段', () => {
    const s: ServiceConfig = { name: 'w', type: 'arq', app: 'app.worker' }
    expect(adapterFor('arq').defaultStartCommand(s, rc(s, {}))).toBe('uv run arq app.worker.WorkerSettings')
  })
  it('celery 用 app 字段', () => {
    const s: ServiceConfig = { name: 'w', type: 'celery', app: 'app.celery' }
    expect(adapterFor('celery').defaultStartCommand(s, rc(s, {}))).toBe('uv run celery -A app.celery worker')
  })
  it('fastapi 缺 app → CONFIG_INVALID', () => {
    const s: ServiceConfig = { name: 'b', type: 'fastapi', port_base: 10000 }
    expect(() => adapterFor('fastapi').defaultStartCommand(s, rc(s, { b: 10002 }))).toThrow(/CONFIG_INVALID|app/)
  })
  it('django 缺端口 → CONFIG_INVALID', () => {
    const s: ServiceConfig = { name: 'b', type: 'django' }
    expect(() => adapterFor('django').defaultStartCommand(s, rc(s, {}))).toThrow(/CONFIG_INVALID|端口|port/)
  })
  it('vite 缺端口 → CONFIG_INVALID', () => {
    const s: ServiceConfig = { name: 'f', type: 'vite' }
    expect(() => adapterFor('vite').defaultStartCommand(s, rc(s, {}))).toThrow(/CONFIG_INVALID|端口|port/)
  })
})

describe('injectionModeFor', () => {
  it('缺省按 type 推导', () => {
    expect(injectionModeFor({ name: 'b', type: 'django' })).toBe('dotEnv')
    expect(injectionModeFor({ name: 'f', type: 'vite' })).toBe('dotEnv')
  })
  it('显式覆盖', () =>
    expect(injectionModeFor({ name: 'b', type: 'django', injectionMode: 'startupArgs' })).toBe('startupArgs'))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/frameworks/command.test.ts`
Expected: FAIL（签名不符 / `injectionModeFor` 未导出）

- [ ] **Step 3: 改 FrameworkAdapter 接口**

整体替换 `src/frameworks/types.ts`：

```ts
import type { ServiceConfig, ServiceType, ResourceNames, ResolveContext } from '../core/types.js'

export interface FrameworkAdapter {
  type: ServiceType
  defaultInjectionMode: 'dotEnv' | 'startupArgs'
  detect(dir: string): boolean
  defaultStartCommand(svc: ServiceConfig, rc: ResolveContext): string
  envVars(names: ResourceNames): Record<string, string>
}
```

- [ ] **Step 4: 改 5 个 adapter**

`src/frameworks/django.ts`：加 `defaultInjectionMode: 'dotEnv'`，取端口改从 rc：

```ts
export const django: FrameworkAdapter = {
  type: 'django',
  defaultInjectionMode: 'dotEnv',
  detect: (dir) => existsSync(join(dir, 'manage.py')),
  defaultStartCommand: (svc, rc) => {
    const port = rc.names.ports[svc.name]
    if (port === undefined) throw new BkError(Codes.CONFIG_INVALID, 'django service 需要端口（设置 port_base）')
    return `uv run python manage.py runserver 0.0.0.0:${port}`
  },
  envVars: backendEnvVars,
}
```

`src/frameworks/fastapi.ts`：

```ts
  defaultInjectionMode: 'dotEnv',
  defaultStartCommand: (svc, rc) => {
    if (!svc.app) throw new BkError(Codes.CONFIG_INVALID,
      `fastapi service ${svc.name} 需在 config 设置 app（如 app.main:app）或 command`)
    const port = rc.names.ports[svc.name]
    if (port === undefined) throw new BkError(Codes.CONFIG_INVALID,
      `fastapi service ${svc.name} 需要端口（设置 port_base）`)
    return `uv run uvicorn ${svc.app} --port ${port}`
  },
```

`src/frameworks/vite.ts`：

```ts
  defaultInjectionMode: 'dotEnv',
  defaultStartCommand: (svc, rc) => {
    const port = rc.names.ports[svc.name]
    if (port === undefined) throw new BkError(Codes.CONFIG_INVALID, 'vite service 需要端口（设置 port_base）')
    return `npm run dev -- --port ${port} --strictPort`
  },
```

`src/frameworks/arq.ts` 与 `celery.ts`：各加 `defaultInjectionMode: 'dotEnv'`，并把 `defaultStartCommand: (svc) =>` 改为 `defaultStartCommand: (svc, _rc) =>`（签名对齐，函数体不变）。

- [ ] **Step 5: 加 injectionModeFor 到 registry.ts**

`src/frameworks/registry.ts` 末尾追加（`ServiceConfig` 需 import）：

```ts
import type { ServiceType, ServiceConfig } from '../core/types.js'
// ...existing imports...

export function injectionModeFor(svc: ServiceConfig): 'dotEnv' | 'startupArgs' {
  return svc.injectionMode ?? adapterFor(svc.type).defaultInjectionMode
}
```

- [ ] **Step 6: 改 buildLaunchSpecs 调用点**

`src/launch/index.ts`，顶部加 import：

```ts
import { namesFromSet } from '../core/allocator.js'
import type { ResolveContext } from '../core/types.js'
```

`buildLaunchSpecs` 内，把默认命令分支改为构造 rc 调新签名（暂只改 defaultStartCommand 调用，dotEnv 结构不变）：

```ts
export function buildLaunchSpecs(ctx: Ctx, set: SetRecord, worktreeDir: string, only?: string): LaunchSpec[] {
  const names = namesFromSet(set)
  return ctx.config.services
    .filter(s => !only || s.name === only)
    .map(s => {
      const port = names.ports[s.name]
      let command: string
      if (s.command) {
        if (s.command.includes('{port}') && port === undefined)
          throw new BkError(Codes.CONFIG_INVALID,
            `service ${s.name} 无端口但 command 引用了 {port}`,
            { remediation: '移除 {port} 或为该 service 设置 port_base' })
        command = port !== undefined ? s.command.replace(/\{port\}/g, String(port)) : s.command
      } else {
        const rc: ResolveContext = { self: s, names, infra: ctx.config.infra }
        command = adapterFor(s.type).defaultStartCommand(s, rc)
      }
      return { name: s.name, command, cwd: join(worktreeDir, s.dir ?? '.'), port }
    })
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run tests/frameworks/ tests/launch/buildSpecs.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/frameworks/ src/launch/index.ts tests/frameworks/command.test.ts
git commit -m "refactor(frameworks): defaultStartCommand 收 ResolveContext 去冗余 port，加 defaultInjectionMode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: springboot adapter + 检测 + 注册

**Files:**
- Create: `src/frameworks/springboot.ts`
- Modify: `src/frameworks/registry.ts`（ALL 数组加 springboot）
- Create fixtures: `tests/fixtures/springboot-proj/pom.xml`
- Test: `tests/frameworks/detect.test.ts`、`tests/frameworks/springboot.test.ts`

**Interfaces:**
- Consumes: `FrameworkAdapter`（Task 4）。
- Produces: `springboot: FrameworkAdapter`（`type: 'springboot'`、`defaultInjectionMode: 'startupArgs'`、`detect` 认 pom/gradle、`defaultStartCommand` 抛错）。

- [ ] **Step 1: 建 fixture**

`tests/fixtures/springboot-proj/pom.xml`：

```xml
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.0</version>
  </parent>
  <artifactId>demo</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
  </dependencies>
</project>
```

- [ ] **Step 2: 写失败测试**

在 `tests/frameworks/detect.test.ts` 的 `describe` 内加一行：

```ts
  it('pom 含 spring-boot → springboot', () => expect(detectType(fx('springboot-proj'))).toBe('springboot'))
```

新建 `tests/frameworks/springboot.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { springboot } from '../../src/frameworks/springboot.js'
import type { ResolveContext, ServiceConfig } from '../../src/core/types.js'

function withDir(files: Record<string, string>, fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'sb-'))
  try { for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c); fn(dir) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('springboot.detect', () => {
  it('pom 含 spring-boot 且非聚合 → true', () =>
    withDir({ 'pom.xml': '<project><parent><groupId>org.springframework.boot</groupId></parent></project>' },
      (d) => expect(springboot.detect(d)).toBe(true)))
  it('父聚合 pom（packaging=pom）→ false', () =>
    withDir({ 'pom.xml': '<project><packaging>pom</packaging><dependency>org.springframework.boot</dependency></project>' },
      (d) => expect(springboot.detect(d)).toBe(false)))
  it('build.gradle 含 spring-boot → true', () =>
    withDir({ 'build.gradle': "plugins { id 'org.springframework.boot' version '3.2.0' }" },
      (d) => expect(springboot.detect(d)).toBe(true)))
  it('无特征 → false', () => withDir({ 'README.md': 'x' }, (d) => expect(springboot.detect(d)).toBe(false)))
})

describe('springboot.defaultStartCommand', () => {
  it('无默认命令 → CONFIG_INVALID 要求 startCommand', () => {
    const s: ServiceConfig = { name: 'api', type: 'springboot', port_base: 10200 }
    const rc: ResolveContext = { self: s, names: { ports: { api: 10202 } }, infra: {} }
    expect(() => springboot.defaultStartCommand(s, rc)).toThrow(/CONFIG_INVALID|startCommand/)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/frameworks/springboot.test.ts tests/frameworks/detect.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 springboot.ts**

`src/frameworks/springboot.ts`：

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'

const SPRING = /org\.springframework\.boot/
const AGGREGATOR = /<packaging>\s*pom\s*<\/packaging>/

function detect(dir: string): boolean {
  const pom = join(dir, 'pom.xml')
  if (existsSync(pom)) {
    const t = readFileSync(pom, 'utf8')
    return SPRING.test(t) && !AGGREGATOR.test(t)
  }
  for (const g of ['build.gradle', 'build.gradle.kts']) {
    const p = join(dir, g)
    if (existsSync(p) && SPRING.test(readFileSync(p, 'utf8'))) return true
  }
  return false
}

export const springboot: FrameworkAdapter = {
  type: 'springboot',
  defaultInjectionMode: 'startupArgs',
  detect,
  defaultStartCommand: (svc) => {
    throw new BkError(Codes.CONFIG_INVALID,
      `springboot service ${svc.name} 没有默认启动命令，请配置 startCommand`,
      { remediation: 'mvn / gradle / java -jar 各异，需在 bk_config.yml 显式写 startCommand 数组' })
  },
  envVars: () => ({}),
}
```

- [ ] **Step 5: 注册**

`src/frameworks/registry.ts`：import 并加入 `ALL`：

```ts
import { springboot } from './springboot.js'
const ALL: FrameworkAdapter[] = [django, fastapi, vite, arq, celery, springboot]
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/frameworks/`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/frameworks/springboot.ts src/frameworks/registry.ts tests/frameworks/springboot.test.ts tests/frameworks/detect.test.ts tests/fixtures/springboot-proj/
git commit -m "feat(frameworks): springboot adapter（检测 pom/gradle，强制 startCommand）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: shell 渲染器（posix / PowerShell 引号）

**Files:**
- Create: `src/launch/render.ts`
- Test: `tests/launch/render.test.ts`

**Interfaces:**
- Produces: `renderPosix(env: Record<string,string>, argv: string[]): string`；`renderPowerShell(env: Record<string,string>, argv: string[]): string`。

- [ ] **Step 1: 写失败测试**

新建 `tests/launch/render.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { renderPosix, renderPowerShell } from '../../src/launch/render.js'

describe('renderPosix', () => {
  it('env 前缀 + 单引号包裹每个 argv 元素', () => {
    expect(renderPosix({ K: 'v' }, ['java', '-jar', 'app.jar']))
      .toBe(`K='v' 'java' '-jar' 'app.jar'`)
  })
  it('含空格的元素整体括起，不被拆断', () => {
    expect(renderPosix({}, ['mvn', 'spring-boot:run', '-Dargs=--a=1 --b=2']))
      .toBe(`'mvn' 'spring-boot:run' '-Dargs=--a=1 --b=2'`)
  })
  it('值里的单引号被转义', () => {
    expect(renderPosix({ K: `a'b` }, ['x'])).toBe(`K='a'\\''b' 'x'`)
  })
  it('无 env 时无前缀', () => expect(renderPosix({}, ['x'])).toBe(`'x'`))
})

describe('renderPowerShell', () => {
  it('$env 前缀 + 调用算子 + 单引号', () => {
    expect(renderPowerShell({ K: 'v' }, ['java', '-jar', 'app.jar']))
      .toBe(`$env:K='v'; & 'java' '-jar' 'app.jar'`)
  })
  it('含空格元素整体括起', () => {
    expect(renderPowerShell({}, ['mvn', '-Dargs=--a=1 --b=2']))
      .toBe(`& 'mvn' '-Dargs=--a=1 --b=2'`)
  })
  it('值里单引号翻倍转义', () => {
    expect(renderPowerShell({}, [`a'b`])).toBe(`& 'a''b'`)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/launch/render.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 render.ts**

`src/launch/render.ts`：

```ts
function sqPosix(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'` }
function sqPs(s: string): string { return `'${s.replace(/'/g, `''`)}'` }

export function renderPosix(env: Record<string, string>, argv: string[]): string {
  const e = Object.entries(env).map(([k, v]) => `${k}=${sqPosix(v)}`).join(' ')
  const cmd = argv.map(sqPosix).join(' ')
  return e ? `${e} ${cmd}` : cmd
}

export function renderPowerShell(env: Record<string, string>, argv: string[]): string {
  const e = Object.entries(env).map(([k, v]) => `$env:${k}=${sqPs(v)}; `).join('')
  const [exe, ...rest] = argv
  const cmd = [`& ${sqPs(exe)}`, ...rest.map(sqPs)].join(' ')
  return `${e}${cmd}`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/launch/render.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/launch/render.ts tests/launch/render.test.ts
git commit -m "feat(launch): posix/PowerShell shell 渲染器（env 前缀 + argv 引号）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: buildLaunchSpecs 按 injectionMode 分流（产出 argv/env）

**Files:**
- Modify: `src/launch/index.ts`（`LaunchSpec` 接口 + `buildLaunchSpecs`）
- Test: `tests/launch/buildSpecs.test.ts`

**Interfaces:**
- Consumes: `injectionModeFor`（Task 4）、`resolveTokens`（Task 3）、`interpolateEnvs`（Task 3）。
- Produces: `LaunchSpec` 增加可选 `argv?: string[]`、`env?: Record<string,string>`、`command?` 变为可选。startupArgs service 产出 `{ argv, env }`；dotEnv 产出 `{ command }`。

- [ ] **Step 1: 写失败测试**

在 `tests/launch/buildSpecs.test.ts` 追加：

```ts
import { injectionModeFor } from '../../src/frameworks/registry.js'

describe('buildLaunchSpecs startupArgs 分流', () => {
  const sbCtx: Ctx = { projectRoot: '/x', config: { project_name: 'foo',
    infra: { postgres: { host: 'localhost', port: 5432, username: 'pg', password: 'sec' } },
    services: [{ name: 'api', type: 'springboot', port_base: 10200,
      startCommand: ['mvn', 'spring-boot:run',
        '-Dspring-boot.run.arguments=--server.port={self.port} --spring.datasource.url=jdbc:postgresql://{infra.postgres.host}:{infra.postgres.port}/{db.name}'],
      envs: { SPRING_DATASOURCE_PASSWORD: '{infra.postgres.password}' } }] } }
  const sbSet: SetRecord = { status: 'allocated', owner: { worktree: '/wt', branch: 'x' },
    resources: { api: { port: 10202 }, postgres: { database: 'foo_2' } }, created_at: 't' }

  it('startupArgs：产出插值后的 argv 与 env，无 command', () => {
    const spec = buildLaunchSpecs(sbCtx, sbSet, '/wt')[0]
    expect(spec.command).toBeUndefined()
    expect(spec.argv).toEqual(['mvn', 'spring-boot:run',
      '-Dspring-boot.run.arguments=--server.port=10202 --spring.datasource.url=jdbc:postgresql://localhost:5432/foo_2'])
    expect(spec.env).toEqual({ SPRING_DATASOURCE_PASSWORD: 'sec' })
  })
  it('startupArgs 缺 startCommand → CONFIG_INVALID', () => {
    const bad: Ctx = { ...sbCtx, config: { ...sbCtx.config,
      services: [{ name: 'api', type: 'springboot', port_base: 10200 }] } }
    expect(() => buildLaunchSpecs(bad, sbSet, '/wt')).toThrow(/CONFIG_INVALID|startCommand/)
  })
  it('dotEnv service 仍产出 command，无 argv', () => {
    const spec = buildLaunchSpecs(ctx, set, '/wt').find(s => s.name === 'backend')!
    expect(spec.command).toContain('manage.py runserver')
    expect(spec.argv).toBeUndefined()
  })
})
```

（`ctx`/`set` 为文件顶部既有 dotEnv 夹具。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/launch/buildSpecs.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 LaunchSpec 与 buildLaunchSpecs**

`src/launch/index.ts`，`LaunchSpec` 改为：

```ts
export interface LaunchSpec {
  name: string; cwd: string; port?: number
  command?: string
  argv?: string[]
  env?: Record<string, string>
}
```

顶部加 import：

```ts
import { adapterFor, injectionModeFor } from '../frameworks/registry.js'
import { resolveTokens, interpolateEnvs } from '../inject/interpolate.js'
```

`buildLaunchSpecs` 整体替换：

```ts
export function buildLaunchSpecs(ctx: Ctx, set: SetRecord, worktreeDir: string, only?: string): LaunchSpec[] {
  const names = namesFromSet(set)
  return ctx.config.services
    .filter(s => !only || s.name === only)
    .map(s => {
      const port = names.ports[s.name]
      const cwd = join(worktreeDir, s.dir ?? '.')
      const rc: ResolveContext = { self: s, names, infra: ctx.config.infra }

      if (injectionModeFor(s) === 'startupArgs') {
        if (!s.startCommand?.length)
          throw new BkError(Codes.CONFIG_INVALID,
            `service ${s.name}（injectionMode startupArgs）需要 startCommand`,
            { remediation: '在 bk_config.yml 为该 service 写 startCommand 数组' })
        const argv = s.startCommand.map(el => resolveTokens(el, rc, `service ${s.name} 的 startCommand`))
        const env = interpolateEnvs(s.envs ?? {}, rc)
        return { name: s.name, cwd, port, argv, env }
      }

      let command: string
      if (s.command) {
        if (s.command.includes('{port}') && port === undefined)
          throw new BkError(Codes.CONFIG_INVALID,
            `service ${s.name} 无端口但 command 引用了 {port}`,
            { remediation: '移除 {port} 或为该 service 设置 port_base' })
        command = port !== undefined ? s.command.replace(/\{port\}/g, String(port)) : s.command
      } else {
        command = adapterFor(s.type).defaultStartCommand(s, rc)
      }
      return { name: s.name, command, cwd, port }
    })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/launch/buildSpecs.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/launch/index.ts tests/launch/buildSpecs.test.ts
git commit -m "feat(launch): buildLaunchSpecs 按 injectionMode 分流产出 argv/env

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 各 launcher 消费 argv/env（tmux/wt/win/print + runLaunch）

**Files:**
- Modify: `src/launch/print.ts`、`tmux.ts`、`wt.ts`、`win.ts`
- Test: `tests/launch/print.test.ts`、`tmux.test.ts`、`wt.test.ts`、`win.test.ts`

**Interfaces:**
- Consumes: `LaunchSpec.argv/env`（Task 7）、`renderPosix`/`renderPowerShell`（Task 6）。
- Produces: 各 launcher 内部 `lineFor(spec)`（tmux/print 用 posix，wt/win 用 PowerShell）。win 的 `buildWinSpawn` 返回的 `opts` 增加 `env?`。

- [ ] **Step 1: 写失败测试**

`tests/launch/print.test.ts` 追加（沿用其 import 的 `renderPrint`）：

```ts
it('startupArgs spec：渲染 posix env 前缀 + argv', () => {
  const out = renderPrint([{ name: 'api', cwd: '/wt/api', argv: ['mvn', 'spring-boot:run'], env: { K: 'v' } }])
  expect(out).toContain(`K='v' 'mvn' 'spring-boot:run'`)
})
```

`tests/launch/win.test.ts` 追加（沿用其 import 的 `buildWinSpawn`）：

```ts
it('startupArgs spec：argv 走 PowerShell 调用算子，env 进 spawn opts.env', () => {
  const { args, opts } = buildWinSpawn(
    { name: 'api', cwd: '/wt/api', argv: ['mvn', 'spring-boot:run'], env: { K: 'v' } }, 'pwsh')
  expect(args[args.length - 1]).toBe(`& 'mvn' 'spring-boot:run'`)
  expect(opts.env).toMatchObject({ K: 'v' })
})
it('dotEnv spec：command 原样，opts.env 不设', () => {
  const { args, opts } = buildWinSpawn({ name: 'b', cwd: '/wt', command: 'uv run x' }, 'pwsh')
  expect(args).toContain('uv run x')
  expect(opts.env).toBeUndefined()
})
```

`tests/launch/wt.test.ts` 追加（沿用其 import 的 `buildWtArgs`）：

```ts
it('startupArgs spec：paneScript 用 PowerShell 渲染 env+argv', () => {
  const args = buildWtArgs([{ name: 'api', cwd: '/wt/api', argv: ['mvn', 'run'], env: { K: 'v' } }], 'pwsh', ['/tmp/p.pid'])
  const joined = args.join(' ')
  expect(joined).toContain(`$env:K='v'; & 'mvn' 'run'`)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/launch/print.test.ts tests/launch/win.test.ts tests/launch/wt.test.ts`
Expected: FAIL

- [ ] **Step 3: 加共享辅助并改 launcher**

`src/launch/index.ts` 末尾导出两个 helper（供 launcher 复用；避免各处重复分支）：

```ts
import { renderPosix, renderPowerShell } from './render.js'

export function posixLine(spec: LaunchSpec): string {
  return spec.argv ? renderPosix(spec.env ?? {}, spec.argv) : spec.command!
}
export function psCommand(spec: LaunchSpec): string {
  // win 走 spawn opts.env 注入环境，故这里 env 传空；wt 需把 env 一并渲进串
  return spec.argv ? renderPowerShell({}, spec.argv) : spec.command!
}
export function psPaneCommand(spec: LaunchSpec): string {
  return spec.argv ? renderPowerShell(spec.env ?? {}, spec.argv) : spec.command!
}
```

`src/launch/print.ts` 改为用 posixLine：

```ts
import type { LaunchSpec } from './index.js'
import { posixLine } from './index.js'

export function renderPrint(specs: LaunchSpec[]): string {
  return specs.map(s => `# ${s.name}  (cwd: ${s.cwd})\n${posixLine(s)}`).join('\n\n')
}
```

`src/launch/tmux.ts`：把两处 `first.command` / `s.command` 改为 `posixLine(first)` / `posixLine(s)`，并 `import { posixLine } from './index.js'`。

`src/launch/wt.ts`：`buildWtArgs` 内 `paneScript(s.command, ...)` 改为 `paneScript(psPaneCommand(s), ...)`，并 import `psPaneCommand`。

`src/launch/win.ts`：`buildWinSpawn` 改为：

```ts
import { spawn } from 'node:child_process'
import type { LaunchSpec } from './index.js'
import { psCommand } from './index.js'

export function buildWinSpawn(spec: LaunchSpec, psHost: string): {
  file: string; args: string[]
  opts: { cwd: string; detached: true; stdio: 'ignore'; windowsHide: false; env?: NodeJS.ProcessEnv }
} {
  return {
    file: psHost,
    args: ['-NoExit', '-Command', psCommand(spec)],
    opts: {
      cwd: spec.cwd, detached: true, stdio: 'ignore', windowsHide: false,
      env: spec.env ? { ...process.env, ...spec.env } : undefined,
    },
  }
}
```

`runWin` 内 `spawn(file, args, opts)` 已透传 opts，无需改。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/launch/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/launch/ tests/launch/
git commit -m "feat(launch): tmux/wt/win/print 消费 argv/env 并按 shell 渲染

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: allocate 对 startupArgs service 跳过 .env 写入

**Files:**
- Modify: `src/cli/commands/allocate.ts`（`buildDirEnvs` 与 `serviceEnvDirs`）
- Test: `tests/cli/allocate.flow.test.ts`

**Interfaces:**
- Consumes: `injectionModeFor`（Task 4）。
- Produces: startupArgs service 的 `envs` 不进 `.env`（走进程环境，Task 8 已在 launch 注入）。

- [ ] **Step 1: 写失败测试**

在 `tests/cli/allocate.flow.test.ts` 追加一个用例（沿用其既有的 doAllocate + 临时 worktree 夹具风格；下例给出断言核心，按文件现有 helper 组织）：

```ts
import { buildDirEnvs } from '../../src/cli/commands/allocate.js'
import type { Ctx, ResourceNames } from '../../src/core/types.js'

describe('buildDirEnvs 跳过 startupArgs', () => {
  const names: ResourceNames = { ports: { api: 10202, web: 10102 }, database: 'foo_2' }
  const ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
    services: [
      { name: 'api', type: 'springboot', dir: 'api', port_base: 10200,
        envs: { SPRING_DATASOURCE_PASSWORD: 'sec' } },
      { name: 'web', type: 'vite', dir: 'web', port_base: 10100,
        envs: { VITE_API_BASE: 'http://localhost:{api.port}' } },
    ] } } as unknown as Ctx

  it('startupArgs service 不产生 .env 内容，dotEnv service 正常', () => {
    const byDir = buildDirEnvs(ctx, names)
    expect(byDir.has('api')).toBe(false)
    expect(byDir.get('web')).toEqual({ VITE_API_BASE: 'http://localhost:10202' })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/cli/allocate.flow.test.ts`
Expected: FAIL（api 目录仍被写入）

- [ ] **Step 3: 改 buildDirEnvs 与 serviceEnvDirs**

`src/cli/commands/allocate.ts`，顶部 import 加 `injectionModeFor`：

```ts
import { adapterFor } from '../../frameworks/registry.js'
import { injectionModeFor } from '../../frameworks/registry.js'
```

`buildDirEnvs` 循环体开头加跳过：

```ts
  for (const svc of ctx.config.services) {
    if (injectionModeFor(svc) === 'startupArgs') continue  // envs 走进程环境，不写 .env
    const rc = { self: svc, names, infra: ctx.config.infra }
    ...
```

`serviceEnvDirs`（用于 deallocate 时清 `.env`）也只保留 dotEnv service 的目录，避免误删 startupArgs 目录里用户自己的 `.env`：

```ts
export function serviceEnvDirs(ctx: Ctx): string[] {
  return [...new Set(ctx.config.services
    .filter(s => injectionModeFor(s) !== 'startupArgs')
    .map(s => s.dir ?? '.'))]
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/cli/allocate.flow.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/cli/commands/allocate.ts tests/cli/allocate.flow.test.ts
git commit -m "feat(allocate): startupArgs service 跳过 .env 写入/清理

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `bk init` springboot 起草（多模块 + ORM 注释）

**Files:**
- Modify: `src/cli/commands/init.ts`（`buildConfigDraft` 内加 springboot 分支 + `detectSpringOrm`）
- Test: `tests/cli/init.test.ts`

**Interfaces:**
- Consumes: 现有 `buildConfigDraft` 逐目录 `detectType` 骨架。
- Produces: springboot service 的注释草稿（`startCommand` stub + `envs` stub + ORM 提示）。

- [ ] **Step 1: 写失败测试**

`tests/cli/init.test.ts` 追加：

```ts
it('多模块 springboot：每模块一 service + 端口递增 + startCommand 注释', () => {
  const root = mkdtempSync(join(tmpdir(), 'sb-'))
  try {
    mkdirSync(join(root, 'order-service'))
    writeFileSync(join(root, 'order-service', 'pom.xml'),
      '<project><parent><groupId>org.springframework.boot</groupId></parent>' +
      '<dependency><artifactId>spring-boot-starter-data-jpa</artifactId></dependency></project>')
    mkdirSync(join(root, 'user-service'))
    writeFileSync(join(root, 'user-service', 'pom.xml'),
      '<project><parent><groupId>org.springframework.boot</groupId></parent>' +
      '<dependency><artifactId>mybatis-spring-boot-starter</artifactId></dependency></project>')
    const yml = buildConfigDraft(root)
    expect(yml).toMatch(/order-service:[\s\S]*type: springboot/)
    expect(yml).toMatch(/user-service:[\s\S]*type: springboot/)
    expect(yml).toContain('port_base: 10000')
    expect(yml).toContain('port_base: 10100')
    expect(yml).toContain('#   - mvn')
    expect(yml).toContain('#   SPRING_DATASOURCE_URL')
    expect(yml).toContain('侦测到 MyBatis')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('父聚合 pom（packaging=pom）不生成 service', () => {
  const root = mkdtempSync(join(tmpdir(), 'sb-'))
  try {
    writeFileSync(join(root, 'pom.xml'),
      '<project><packaging>pom</packaging><groupId>org.springframework.boot</groupId></project>')
    const yml = buildConfigDraft(root)
    expect(yml).toContain('# TODO 未侦测到 service，请手动填写')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/cli/init.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 springboot 起草**

`src/cli/commands/init.ts`，加 ORM 侦测函数（放在 `detectWorkerLibs` 附近）：

```ts
function detectSpringOrm(dir: string): 'jpa' | 'mybatis' | null {
  for (const f of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    const p = join(dir, f)
    if (!existsSync(p)) continue
    const t = readFileSync(p, 'utf8')
    if (/spring-boot-starter-data-jpa/.test(t)) return 'jpa'
    if (/mybatis-spring-boot-starter|org\.mybatis/.test(t)) return 'mybatis'
  }
  return null
}
```

在 `buildConfigDraft` 的服务循环内（`if (s.type === 'vite')` 分支之后、`for (const lib of detectWorkerLibs...)` 之前）加 springboot 分支：

```ts
    if (s.type === 'springboot') {
      const orm = detectSpringOrm(join(projectDir, s.dir))
      lines.push(
        '    # injectionMode: startupArgs           # springboot 默认即此，通常无需写',
        '    # startCommand:                        # TODO 选一种跑法（mvn / gradle / java -jar）',
        '    #   - mvn',
        '    #   - spring-boot:run',
        '    #   - -Dspring-boot.run.arguments=--server.port={self.port} --spring.datasource.url=jdbc:postgresql://{infra.postgres.host}:{infra.postgres.port}/{db.name}',
        '    # envs:                                # TODO 需要走环境变量的（如密码）',
        '    #   SPRING_DATASOURCE_URL: jdbc:postgresql://{infra.postgres.host}:{infra.postgres.port}/{db.name}',
        '    #   SPRING_DATASOURCE_USERNAME: "{infra.postgres.username}"',
        '    #   SPRING_DATASOURCE_PASSWORD: "{infra.postgres.password}"')
      if (orm === 'mybatis')
        lines.push('    #   # 侦测到 MyBatis：mapper 等非连接属性 bk 不碰，按需自填')
      if (orm === 'jpa')
        lines.push('    #   # 侦测到 JPA：spring.jpa.* 等非连接属性 bk 不碰，按需自填')
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/cli/init.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/cli/commands/init.ts tests/cli/init.test.ts
git commit -m "feat(init): springboot 多模块起草 + ORM(JPA/MyBatis) 注释提示

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: 全量测试 + 类型检查 + 文档

**Files:**
- Modify: `README.md`、`CHANGELOG.md`
- 验证：全套测试与 `tsc`

**Interfaces:** 无新接口。

- [ ] **Step 1: 全量测试与类型检查**

Run: `npm test`
Expected: 全绿（含 integration 若本地无 docker 会跳过/失败——只关注非 integration 用例通过；integration 用例需 docker）。

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 2: 更新 README**

`README.md` 的"默认启动命令"表格上方 type 列表加入 `springboot`；在"配置注入"节后新增一小节，说明：

```markdown
### injectionMode 与 SpringBoot

- `injectionMode`：`dotEnv`（默认，django/fastapi/vite/arq/celery）把变量写进 service 目录 `.env`；`startupArgs`（默认，springboot）改为在 `bk start` 时注入进程。
- SpringBoot 默认不读 `.env`，故用 `startupArgs`：
  - **命令行参数 / `-D` 系统属性**：写进 `startCommand` 数组元素，用 token 插值，位置由你掌控（`java -jar` 后、或 `mvn -Dspring-boot.run.arguments=` 里）。
  - **进程环境变量**：写进 `envs`（key 为大写环境变量名），bk 启动前注入进程环境。
- token：`{self.port}`、`{<svc>.port}`、`{db.name}`、`{redis.db}`/`{redis.prefix}`、`{minio.bucket}`、`{infra.postgres.host|port|username|password}`、`{infra.redis.host|port}`、`{infra.minio.endpoint|access_key|secret_key}`。
- springboot 无默认启动命令，必须配 `startCommand`。多模块：一模块一 service，`bk init` 自动逐子目录侦测。
```

- [ ] **Step 3: 更新 CHANGELOG**

`CHANGELOG.md` 顶部加一节，简述：新增 springboot service 类型、`injectionMode`（dotEnv/startupArgs）、`startCommand` 数组、通用 token 解析器、多模块 init 与 ORM 起草。

- [ ] **Step 4: 提交**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: springboot 支持与 injectionMode/startCommand/token 说明

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 自审对照

- **Spec 第 1 节（schema）** → Task 1（types/load）、Task 4（defaultInjectionMode）、Task 7（LaunchSpec）。✓
- **Spec 第 2 节（token 解析器）** → Task 3。✓
- **Spec 第 3 节（launch 期机制）** → Task 6（渲染器）、Task 7（分流）、Task 8（launcher 消费）、Task 9（不写 .env）。✓
- **Spec 第 4 节（defaultStartCommand 重构）** → Task 4；`namesFromSet` 前置于 Task 2。✓
- **Spec 第 5 节（检测 + 多模块 init）** → Task 5（detect）、Task 10（init + ORM）。✓
- **类型一致性**：`ResolveContext`（Task 3 定义，Task 4/5/7/9 消费）、`injectionModeFor`（Task 4 定义，Task 7/9 消费）、`namesFromSet`（Task 2 定义，Task 4/7 消费）、`renderPosix/renderPowerShell`（Task 6 定义，Task 8 消费）、`LaunchSpec.argv/env`（Task 7 定义，Task 8 消费）——命名前后一致。✓
- **无占位符**：各 step 均含完整代码与命令。✓
- **零回归**：dotEnv 路径 command 生成与 `.env` 写入逻辑保持（Task 4/7 仅新增分支，dotEnv 分支等价）。✓
