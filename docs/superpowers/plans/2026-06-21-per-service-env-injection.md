# 按 service 量身定制 .env 注入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `bk allocate` 按 service 量身定制 `.env`——后端服务拿 `BK_*` 隔离标识，前端（vite）只拿用户在 `envs` 里声明、且占位符已插值的变量（如 `VITE_API_BASE=http://localhost:10001`），彻底不再给前端塞无用的 `BK_*`。

**Architecture:** env 的来源从「provider 直接产环境变量字符串 + 全局统一块」改为「framework adapter 产类型默认（后端 `BK_*`/vite 空）+ 每个 service 的 `envs` 映射（占位符插值）+ 按目录合并」。provider 退回纯资源职责，只经 `plan()` 产出 `ResourceNames`；新增占位符插值模块解析 `{服务名.port}`；`bk init` 探测前端 `.env*` 自动写好 `envs` 草稿。

**Tech Stack:** TypeScript（ESM，import 带 `.js` 后缀）、Node ≥20、vitest、commander、yaml。

## Global Constraints

- 所有源码 import 必须带 `.js` 后缀（ESM/NodeNext）。
- 报错一律走 `BkError(Codes.XXX, msg, { remediation })`；本计划新增错误用 `Codes.CONFIG_INVALID`。
- `.env` 标记块机制不变：`# >>> bk managed >>>` / `# <<< bk managed <<<`，只动块内、绝不碰块外 secrets（`src/inject/env.ts` 不改）。
- 范围限定**单后端**：占位符目标默认 `{backend.port}`，多后端消歧属非目标。
- 占位符首批仅实现 `{<服务名>.port}`，语法预留但不实现 `{db}`/`{redis_db}`/`{bucket}`。
- 测试用 `npx vitest run <file>`；类型检查用 `npm run typecheck`。
- 集成测试（`*.integration.test.ts`）依赖 testcontainers，本地无 Docker 时会跳过/失败，属预期，按需用单测验证。

---

## 文件结构

**新建：**
- `src/inject/interpolate.ts` — `{服务名.port}` 占位符插值（纯函数）。
- `src/frameworks/backendEnv.ts` — 把 `ResourceNames` 转成后端 `BK_*` 环境变量（4 个后端 adapter 共用）。
- `tests/inject/interpolate.test.ts`
- `tests/frameworks/env.test.ts`

**修改：**
- `src/core/types.ts` — `ServiceConfig.envs?`。
- `src/config/load.ts` — 透传 `envs`。
- `src/frameworks/types.ts` — `FrameworkAdapter.envVars(names)`。
- `src/frameworks/{django,fastapi,arq,celery}.ts` — `envVars = backendEnvVars`。
- `src/frameworks/vite.ts` — `envVars` 返回 `{}`。
- `src/core/allocator.ts` — 删 `collectEnv`，加 `planNames`，`buildSetRecord` 复用之。
- `src/cli/commands/allocate.ts` — `buildDirEnvs` + 重写 `writeServiceEnvs(ctx, worktreeDir, names)`，`doAllocate` 改用 `planNames`。
- `src/providers/types.ts` + `src/providers/{port,postgres,redis,minio}.ts` — 移除 `envVars`。
- `src/cli/commands/init.ts` — 前端 `.env*` 探测，写 `envs` / 注释 stub。
- 测试适配：`tests/cli/allocate.flow.test.ts`、`tests/providers/redis.test.ts`、`tests/providers/postgres.integration.test.ts`、`tests/helpers/fakeProvider.ts`、`tests/config/load.test.ts`、`tests/cli/init.test.ts`。
- `README.md` — env 注入章节 + `envs` 字段 + 占位符语法。

---

## Task 1: `envs` 配置字段贯通（types + load）

**Files:**
- Modify: `src/core/types.ts:4-11`（`ServiceConfig`）
- Modify: `src/config/load.ts:15`
- Test: `tests/config/load.test.ts`

**Interfaces:**
- Produces: `ServiceConfig.envs?: Record<string, string>`；`loadConfig` 解析后该字段可用。

- [ ] **Step 1: 写失败测试**

在 `tests/config/load.test.ts` 的 `describe('loadConfig', ...)` 内追加：

```ts
  it('透传 envs 字段', () => {
    write(`project_name: foo
services:
  frontend:
    type: vite
    port_base: 10100
    envs:
      VITE_API_BASE: http://localhost:{backend.port}
infra: {}
`)
    expect(loadConfig(root).services[0].envs).toEqual({ VITE_API_BASE: 'http://localhost:{backend.port}' })
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/config/load.test.ts -t "透传 envs"`
Expected: FAIL（`envs` 为 `undefined`）

- [ ] **Step 3: 改类型**

`src/core/types.ts` 的 `ServiceConfig` 加一行（放在 `dir?` 之后）：

```ts
export interface ServiceConfig {
  name: string
  type: ServiceType
  port_base?: number
  command?: string
  app?: string
  dir?: string
  envs?: Record<string, string>
}
```

- [ ] **Step 4: 改 loader 透传**

`src/config/load.ts` 第 15 行的 return 加上 `envs`：

```ts
    return { name, type: s.type, port_base: s.port_base, command: s.command, app: s.app, dir: s.dir, envs: s.envs }
```

- [ ] **Step 5: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/config/load.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/core/types.ts src/config/load.ts tests/config/load.test.ts
git commit -m "feat(config): ServiceConfig 新增 envs 字段并由 loadConfig 透传"
```

---

## Task 2: 占位符插值模块

**Files:**
- Create: `src/inject/interpolate.ts`
- Test: `tests/inject/interpolate.test.ts`

**Interfaces:**
- Consumes: `ResourceNames`（来自 `src/core/types.ts`，含 `ports: Record<string, number>`）。
- Produces: `interpolateEnvs(envs: Record<string,string>, names: ResourceNames, svcName: string): Record<string,string>` —— 把每个值里的 `{<服务名>.port}` 替换成 `names.ports[服务名]`；解析不到则抛 `BkError(Codes.CONFIG_INVALID)`。

- [ ] **Step 1: 写失败测试**

Create `tests/inject/interpolate.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { interpolateEnvs } from '../../src/inject/interpolate.js'
import type { ResourceNames } from '../../src/core/types.js'

const names: ResourceNames = { ports: { backend: 10001, frontend: 10101 } }

describe('interpolateEnvs', () => {
  it('替换 {service.port}', () => {
    expect(interpolateEnvs({ VITE_API_BASE: 'http://localhost:{backend.port}/api' }, names, 'frontend'))
      .toEqual({ VITE_API_BASE: 'http://localhost:10001/api' })
  })
  it('一个值里多个占位符', () => {
    expect(interpolateEnvs({ X: '{backend.port}-{frontend.port}' }, names, 'frontend'))
      .toEqual({ X: '10001-10101' })
  })
  it('未知服务名 → CONFIG_INVALID', () => {
    expect(() => interpolateEnvs({ X: '{nope.port}' }, names, 'frontend')).toThrow(/CONFIG_INVALID|nope/)
  })
  it('无占位符原样返回', () => {
    expect(interpolateEnvs({ X: 'plain', Y: '' }, names, 'frontend')).toEqual({ X: 'plain', Y: '' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/inject/interpolate.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现模块**

Create `src/inject/interpolate.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/inject/interpolate.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/inject/interpolate.ts tests/inject/interpolate.test.ts
git commit -m "feat(inject): 新增 {服务名.port} 占位符插值模块"
```

---

## Task 3: 后端 env 助手 + adapter.envVars

**Files:**
- Create: `src/frameworks/backendEnv.ts`
- Modify: `src/frameworks/types.ts:3-7`
- Modify: `src/frameworks/django.ts`、`src/frameworks/fastapi.ts`、`src/frameworks/arq.ts`、`src/frameworks/celery.ts`、`src/frameworks/vite.ts`
- Test: `tests/frameworks/env.test.ts`

**Interfaces:**
- Consumes: `ResourceNames`（`ports/database/redisDb/redisPrefix/bucket`）。
- Produces:
  - `backendEnvVars(names: ResourceNames): Record<string,string>` —— `database→BK_DB_NAME`、`redisDb→BK_REDIS_DB`（否则 `redisPrefix→BK_REDIS_PREFIX`）、`bucket→BK_MINIO_BUCKET`；缺哪个不产哪个。
  - `FrameworkAdapter.envVars(names: ResourceNames): Record<string,string>` —— 后端 4 类返回 `backendEnvVars(names)`，vite 返回 `{}`。

- [ ] **Step 1: 写失败测试**

Create `tests/frameworks/env.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { adapterFor } from '../../src/frameworks/registry.js'
import type { ResourceNames } from '../../src/core/types.js'

const full: ResourceNames = { ports: { backend: 10001 }, database: 'foo_1', redisDb: 1, bucket: 'foo-1' }

describe('adapter.envVars', () => {
  it('django 产 BK_*（取自 names）', () => {
    expect(adapterFor('django').envVars(full))
      .toEqual({ BK_DB_NAME: 'foo_1', BK_REDIS_DB: '1', BK_MINIO_BUCKET: 'foo-1' })
  })
  it('redisPrefix 模式产 BK_REDIS_PREFIX', () => {
    expect(adapterFor('fastapi').envVars({ ports: {}, database: 'foo_1', redisPrefix: 'foo_1_' }))
      .toEqual({ BK_DB_NAME: 'foo_1', BK_REDIS_PREFIX: 'foo_1_' })
  })
  it('无 infra 资源时产空对象', () => {
    expect(adapterFor('arq').envVars({ ports: {} })).toEqual({})
  })
  it('vite 恒空', () => {
    expect(adapterFor('vite').envVars(full)).toEqual({})
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/frameworks/env.test.ts`
Expected: FAIL（`envVars` 不存在 / 不是函数）

- [ ] **Step 3: 写后端 env 助手**

Create `src/frameworks/backendEnv.ts`：

```ts
import type { ResourceNames } from '../core/types.js'

export function backendEnvVars(names: ResourceNames): Record<string, string> {
  const out: Record<string, string> = {}
  if (names.database) out.BK_DB_NAME = names.database
  if (names.redisDb !== undefined) out.BK_REDIS_DB = String(names.redisDb)
  else if (names.redisPrefix) out.BK_REDIS_PREFIX = names.redisPrefix
  if (names.bucket) out.BK_MINIO_BUCKET = names.bucket
  return out
}
```

- [ ] **Step 4: 接口加 envVars**

`src/frameworks/types.ts` 整体改为：

```ts
import type { ServiceConfig, ServiceType, ResourceNames } from '../core/types.js'

export interface FrameworkAdapter {
  type: ServiceType
  detect(dir: string): boolean
  defaultStartCommand(svc: ServiceConfig, port?: number): string
  envVars(names: ResourceNames): Record<string, string>
}
```

- [ ] **Step 5: 4 个后端 adapter 实现 envVars**

`src/frameworks/django.ts`：顶部加 `import { backendEnvVars } from './backendEnv.js'`，并在对象里加一行 `envVars: backendEnvVars,`：

```ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'
import { backendEnvVars } from './backendEnv.js'

export const django: FrameworkAdapter = {
  type: 'django',
  detect: (dir) => existsSync(join(dir, 'manage.py')),
  defaultStartCommand: (_svc, port) => {
    if (port === undefined) throw new BkError(Codes.CONFIG_INVALID, 'django service 需要端口（设置 port_base）')
    return `uv run python manage.py runserver 0.0.0.0:${port}`
  },
  envVars: backendEnvVars,
}
```

`src/frameworks/fastapi.ts`：加 `import { backendEnvVars } from './backendEnv.js'`，对象末尾加 `envVars: backendEnvVars,`。

`src/frameworks/arq.ts`：加 `import { backendEnvVars } from './backendEnv.js'`，对象末尾加 `envVars: backendEnvVars,`。

`src/frameworks/celery.ts`：加 `import { backendEnvVars } from './backendEnv.js'`，对象末尾加 `envVars: backendEnvVars,`。

- [ ] **Step 6: vite adapter 返回空**

`src/frameworks/vite.ts` 对象末尾加：

```ts
  envVars: () => ({}),
```

完整对象应为：

```ts
export const vite: FrameworkAdapter = {
  type: 'vite',
  detect: (dir) => ['vite.config.ts', 'vite.config.js'].some(f => existsSync(join(dir, f))),
  defaultStartCommand: (_svc, port) => {
    if (port === undefined) throw new BkError(Codes.CONFIG_INVALID, 'vite service 需要端口（设置 port_base）')
    return `npm run dev -- --port ${port}`
  },
  envVars: () => ({}),
}
```

- [ ] **Step 7: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/frameworks/env.test.ts && npm run typecheck`
Expected: PASS（类型检查确保 5 个 adapter 都实现了新方法）

- [ ] **Step 8: 提交**

```bash
git add src/frameworks/backendEnv.ts src/frameworks/types.ts src/frameworks/django.ts src/frameworks/fastapi.ts src/frameworks/arq.ts src/frameworks/celery.ts src/frameworks/vite.ts tests/frameworks/env.test.ts
git commit -m "feat(frameworks): adapter 接管 env 产出（后端 BK_*、vite 空）"
```

---

## Task 4: 切换 allocate 到 per-service env

**Files:**
- Modify: `src/core/allocator.ts:37-53`
- Modify: `src/cli/commands/allocate.ts:8,20-22,39`
- Test: `tests/cli/allocate.flow.test.ts`

**Interfaces:**
- Consumes: `interpolateEnvs`（Task 2）、`adapterFor`（`src/frameworks/registry.js`）、`adapter.envVars`（Task 3）。
- Produces:
  - `planNames(providers: ResourceProvider[], ctx: Ctx, n: number): ResourceNames`（`src/core/allocator.ts`）。
  - `buildDirEnvs(ctx: Ctx, names: ResourceNames): Map<string, Record<string,string>>`（`src/cli/commands/allocate.ts`，按 `dir` 合并各 service 的 env）。
  - `writeServiceEnvs(ctx: Ctx, worktreeDir: string, names: ResourceNames): void`（签名由 `vars` 改为 `names`；合并后为空的目录不写块）。
  - `collectEnv` 被删除。

- [ ] **Step 1: 改写 allocate.flow 测试到新模型**

整体替换 `tests/cli/allocate.flow.test.ts` 为：

```ts
// tests/cli/allocate.flow.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { doAllocate, serviceEnvDirs, buildDirEnvs } from '../../src/cli/commands/allocate.js'
import { readState } from '../../src/state/store.js'
import { createPortProvider } from '../../src/providers/port.js'
import { fakeProvider } from '../helpers/fakeProvider.js'
import type { Ctx, ResourceNames } from '../../src/core/types.js'

let home: string, wt: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  wt = mkdtempSync(join(tmpdir(), 'wt-'))
})
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(wt, { recursive: true, force: true }); delete process.env.BK_HOME })

const ctx = (): Ctx => ({ projectRoot: wt, config: {
  project_name: 'foo',
  services: [{ name: 'backend', type: 'django', port_base: 10000 }],
  infra: {},
}})

// port + 一个产 database 的 fake provider（避免连真实 DB，又能让后端写出 BK_DB_NAME 块）
const provs = () => [createPortProvider(), fakeProvider({ kind: 'pg', plan: () => ({ database: 'foo_1' }) })]

describe('doAllocate', () => {
  it('分配号 1、写 .env 标记块（含 BK_DB_NAME）、写 state 为 allocated', async () => {
    const n = await doAllocate(ctx(), wt, 'feature/x', provs())
    expect(n).toBe(1)
    const env = readFileSync(join(wt, '.env'), 'utf8')
    expect(env).toContain('# >>> bk managed >>>')
    expect(env).toContain('BK_DB_NAME=foo_1')
    const s = await readState('foo')
    expect(s.sets['1'].status).toBe('allocated')
    expect(s.sets['1'].owner?.worktree).toBe(wt)
    expect((s.sets['1'].resources['backend'] as any).port).toBe(10001)
  })

  it('provision 后写 .env 失败 → 回滚已建资源、不持久化 state', async () => {
    const destroy = vi.fn(async () => {})
    const fake = fakeProvider({ kind: 'fake', provision: async () => {}, destroy, plan: () => ({ database: 'x' }) })
    const badDir = join(wt, 'does-not-exist-subdir', 'nested')  // parent missing → writeEnvBlock throws ENOENT
    await expect(doAllocate(ctx(), badDir, 'feature/x', [fake])).rejects.toThrow()
    expect(destroy).toHaveBeenCalledWith(1, expect.anything())
    const s = await readState('foo')
    expect(s.sets['1']).toBeUndefined()
  })

  it('service 有 dir → 写到子目录 .env、不写 worktree 根', async () => {
    mkdirSync(join(wt, 'backend'))
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend' }] } }
    await doAllocate(c, wt, 'feature/x', provs())
    expect(existsSync(join(wt, 'backend', '.env'))).toBe(true)
    expect(readFileSync(join(wt, 'backend', '.env'), 'utf8')).toContain('# >>> bk managed >>>')
    expect(existsSync(join(wt, '.env'))).toBe(false)
  })

  it('多个 service 共享同一 dir → 去重，只写一份', async () => {
    mkdirSync(join(wt, 'backend'))
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [
        { name: 'backend', type: 'fastapi', port_base: 10000, app: 'app.main:app', dir: 'backend' },
        { name: 'worker', type: 'arq', app: 'app.worker', dir: 'backend' },
      ] } }
    expect(serviceEnvDirs(c)).toEqual(['backend'])
    await doAllocate(c, wt, 'feature/x', provs())
    expect(existsSync(join(wt, 'backend', '.env'))).toBe(true)
  })
})

describe('buildDirEnvs', () => {
  const names: ResourceNames = { ports: { backend: 10001, frontend: 10101 }, database: 'foo_1' }

  it('前端只得 VITE_API_BASE、不含任何 BK_', () => {
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [
        { name: 'backend', type: 'django', port_base: 10000, dir: 'backend' },
        { name: 'frontend', type: 'vite', port_base: 10100, dir: 'frontend',
          envs: { VITE_API_BASE: 'http://localhost:{backend.port}' } },
      ] } }
    const map = buildDirEnvs(c, names)
    expect(map.get('frontend')).toEqual({ VITE_API_BASE: 'http://localhost:10001' })
    expect(map.get('backend')).toEqual({ BK_DB_NAME: 'foo_1' })
  })

  it('vite 无 envs → 该目录不进 map（空块不写）', () => {
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [{ name: 'frontend', type: 'vite', port_base: 10100, dir: 'frontend' }] } }
    const map = buildDirEnvs(c, names)
    expect(map.has('frontend')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/cli/allocate.flow.test.ts`
Expected: FAIL（`buildDirEnvs` 未导出、`writeServiceEnvs`/`doAllocate` 仍旧逻辑）

- [ ] **Step 3: allocator 加 planNames、删 collectEnv**

`src/core/allocator.ts`：删除 `collectEnv`（37-39 行），新增 `planNames`，并让 `buildSetRecord` 复用它。替换该文件 37 行起到结尾为：

```ts
export function planNames(providers: ResourceProvider[], ctx: Ctx, n: number): ResourceNames {
  return Object.assign({ ports: {} }, ...providers.map(p => p.plan(n, ctx)))
}

export function buildSetRecord(
  providers: ResourceProvider[], ctx: Ctx, n: number,
  owner: SetRecord['owner'],
): SetRecord {
  const names = planNames(providers, ctx, n)
  const resources: SetRecord['resources'] = {}
  for (const [svc, port] of Object.entries(names.ports ?? {})) resources[svc] = { port }
  if (names.database) resources.postgres = { database: names.database }
  if (names.redisPrefix || names.redisDb !== undefined)
    resources.redis = { prefix: names.redisPrefix, db: names.redisDb }
  if (names.bucket) resources.minio = { bucket: names.bucket }
  return { status: owner ? 'allocated' : 'free', owner, resources, created_at: new Date().toISOString() }
}
```

同时确认文件顶部已 `import type { Ctx, ResourceNames, SetRecord } from '../core/types.js'`（原已含 `ResourceNames`）。

- [ ] **Step 4: 重写 allocate.ts 的 env 写入**

`src/cli/commands/allocate.ts`：改 import 行（第 8 行）去掉 `collectEnv`，新增依赖；重写 `writeServiceEnvs` 并新增 `buildDirEnvs`；`doAllocate` 改用 `planNames`。

第 1-22 行替换为：

```ts
// src/cli/commands/allocate.ts
import type { Command } from 'commander'
import { join } from 'node:path'
import type { Ctx, ResourceNames } from '../../core/types.js'
import type { ResourceProvider } from '../../providers/types.js'
import { withState } from '../../state/store.js'
import { activeProviders } from '../../providers/registry.js'
import { resolveSet, provisionSet, buildSetRecord, planNames } from '../../core/allocator.js'
import { writeEnvBlock, removeEnvBlock } from '../../inject/env.js'
import { interpolateEnvs } from '../../inject/interpolate.js'
import { adapterFor } from '../../frameworks/registry.js'
import { ensureGitignore } from '../../inject/gitignore.js'
import { findSetByWorktree, deallocateInState } from '../../core/deallocator.js'
import { loadCtx, maxAttempts, runCommand } from '../context.js'
import { success, info } from '../output.js'
import { fingerprint } from '../../config/fingerprint.js'

export function serviceEnvDirs(ctx: Ctx): string[] {
  return [...new Set(ctx.config.services.map(s => s.dir ?? '.'))]
}

export function buildDirEnvs(ctx: Ctx, names: ResourceNames): Map<string, Record<string, string>> {
  const byDir = new Map<string, Record<string, string>>()
  for (const svc of ctx.config.services) {
    const vars = {
      ...adapterFor(svc.type).envVars(names),
      ...interpolateEnvs(svc.envs ?? {}, names, svc.name),
    }
    if (Object.keys(vars).length === 0) continue
    const dir = svc.dir ?? '.'
    byDir.set(dir, { ...(byDir.get(dir) ?? {}), ...vars })
  }
  return byDir
}

export function writeServiceEnvs(ctx: Ctx, worktreeDir: string, names: ResourceNames): void {
  for (const [dir, vars] of buildDirEnvs(ctx, names))
    writeEnvBlock(join(worktreeDir, dir, '.env'), vars)
}
```

注意：`removeServiceEnvs` 保持原样（仍按 `serviceEnvDirs` 逐个 `removeEnvBlock`），无需改动。

- [ ] **Step 5: doAllocate 改用 planNames**

`src/cli/commands/allocate.ts` 中 `doAllocate` 里原第 39 行：

```ts
      writeServiceEnvs(ctx, worktreeDir, collectEnv(providers, ctx, n))
```

改为：

```ts
      writeServiceEnvs(ctx, worktreeDir, planNames(providers, ctx, n))
```

- [ ] **Step 6: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/cli/allocate.flow.test.ts tests/core/allocator.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/core/allocator.ts src/cli/commands/allocate.ts tests/cli/allocate.flow.test.ts
git commit -m "feat(allocate): env 改为 per-service 按目录合并（前端只写 envs，空块不写）"
```

---

## Task 5: 移除 provider.envVars

**Files:**
- Modify: `src/providers/types.ts:3-10`
- Modify: `src/providers/port.ts:29`、`src/providers/postgres.ts:40`、`src/providers/redis.ts:27-29`、`src/providers/minio.ts:44`
- Modify: `tests/helpers/fakeProvider.ts:6`
- Modify: `tests/providers/redis.test.ts`、`tests/providers/postgres.integration.test.ts`

**Interfaces:**
- Produces: `ResourceProvider` 不再含 `envVars`；env 完全由 framework adapter 负责（Task 3/4）。

- [ ] **Step 1: 删测试里对 provider.envVars 的断言（先让测试反映目标）**

`tests/providers/redis.test.ts`：删除三处 `envVars` 断言行，只留 `plan` 断言。具体：
- 把 `it('plan 产前缀、envVars 含 BK_REDIS_PREFIX', ...)` 改名为 `it('plan 产前缀', ...)` 并删掉第 15 行 `expect(p.envVars(...))`。
- 把 `it('plan 产 redisDb、envVars 含 BK_REDIS_DB', ...)` 改名为 `it('plan 产 redisDb', ...)` 并删掉第 32 行。
- 把 `it('未配置 isolation 时默认 db_number：plan 产 redisDb、envVars 含 BK_REDIS_DB', ...)` 改名去掉 envVars 字样，删掉第 46 行。

改完这三个用例体应为：

```ts
  it('plan 产前缀', () => {
    const p = createRedisProvider()
    expect(p.plan(2, ctx('key_prefix')).redisPrefix).toBe('foo_2_')
  })
```
```ts
  it('plan 产 redisDb', () => {
    const p = createRedisProvider()
    expect(p.plan(3, ctx('db_number')).redisDb).toBe(3)
  })
```
```ts
  it('未配置 isolation 时默认 db_number：plan 产 redisDb', () => {
    const p = createRedisProvider()
    expect(p.plan(3, ctxNoIso).redisDb).toBe(3)
    expect(p.plan(3, ctxNoIso).redisPrefix).toBeUndefined()
  })
```

`tests/providers/postgres.integration.test.ts`：删除第 31 行 `expect(p.envVars(2, ctx).BK_DB_NAME).toBe('foo_2')`。

- [ ] **Step 2: 跑测试确认失败（类型层面）**

Run: `npm run typecheck`
Expected: 仍 PASS（此刻 provider 仍有 envVars），但删断言后这些测试不再覆盖 envVars。继续删实现。

- [ ] **Step 3: 接口删 envVars**

`src/providers/types.ts` 改为：

```ts
import type { Ctx, ResourceNames } from '../core/types.js'

export interface ResourceProvider {
  kind: string
  plan(n: number, ctx: Ctx): Partial<ResourceNames>
  probe(n: number, ctx: Ctx): Promise<boolean>     // true=可用, false=撞了(跳号)
  provision(n: number, ctx: Ctx): Promise<void>
  destroy(n: number, ctx: Ctx): Promise<void>
}
```

- [ ] **Step 4: 各 provider 删 envVars 行**

- `src/providers/port.ts`：删 `envVars: () => ({}),`（第 29 行）。
- `src/providers/postgres.ts`：删 `envVars: (n, ctx) => ({ BK_DB_NAME: dbName(n, ctx) }),`（第 40 行）。
- `src/providers/minio.ts`：删 `envVars: (n, ctx) => ({ BK_MINIO_BUCKET: bucket(n, ctx) }),`（第 44 行）。
- `src/providers/redis.ts`：删 `envVars` 块（27-29 行整段）：

  ```ts
      envVars: (n, ctx): Record<string, string> => cfg(ctx).isolation === 'db_number'
        ? { BK_REDIS_DB: String(n) }
        : { BK_REDIS_PREFIX: prefix(n, ctx) },
  ```

- [ ] **Step 5: fakeProvider 删 envVars 默认**

`tests/helpers/fakeProvider.ts` 改为：

```ts
import type { ResourceProvider } from '../../src/providers/types.js'

export function fakeProvider(opts: Partial<ResourceProvider> & { kind: string }): ResourceProvider {
  return {
    plan: () => ({}), probe: async () => true, provision: async () => {},
    destroy: async () => {}, ...opts,
  }
}
```

- [ ] **Step 6: 跑全量单测 + 类型检查**

Run: `npx vitest run tests/providers/redis.test.ts tests/providers/port.test.ts tests/core tests/cli/allocate.flow.test.ts && npm run typecheck`
Expected: PASS（类型检查确保再无 `.envVars` 引用残留）

- [ ] **Step 7: 提交**

```bash
git add src/providers tests/helpers/fakeProvider.ts tests/providers/redis.test.ts tests/providers/postgres.integration.test.ts
git commit -m "refactor(providers): 移除 provider.envVars，env 来源收口到 framework adapter"
```

---

## Task 6: `bk init` 探测前端 `.env*` 写 envs

**Files:**
- Modify: `src/cli/commands/init.ts`
- Test: `tests/cli/init.test.ts`

**Interfaces:**
- Produces: `buildConfigDraft` 对 vite service 追加 `envs:`（探到 `VITE_*=http://...localhost.../...` 时）或注释 `# envs:` stub（探不到时）；占位符目标取第一个非 vite 服务名（缺省 `backend`）。

- [ ] **Step 1: 写失败测试**

在 `tests/cli/init.test.ts` 的 `describe('buildConfigDraft', ...)` 内追加（复用顶部 beforeEach 建好的 `dir`，其中已含 `backend/manage.py` 与 `frontend/vite.config.ts`）：

```ts
  it('vite dir 有 .env.example 含 VITE_API_BASE → 写 envs（端口换占位符）', () => {
    writeFileSync(join(dir, 'frontend', '.env.example'), 'VITE_API_BASE=http://localhost:8000/api\n')
    const yml = buildConfigDraft(dir)
    expect(yml).toMatch(/frontend:[\s\S]*    envs:/)
    expect(yml).toContain('      VITE_API_BASE: http://localhost:{backend.port}/api')
  })

  it('vite dir 无 .env* → 写注释 envs stub', () => {
    const yml = buildConfigDraft(dir)
    expect(yml).toContain('    # envs:')
    expect(yml).toContain('    #   VITE_API_BASE: http://localhost:{backend.port}')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/cli/init.test.ts -t "envs"`
Expected: FAIL（草稿里无 envs 行）

- [ ] **Step 3: 加探测助手**

`src/cli/commands/init.ts`：在 `detectWorkerLibs` 之后加：

```ts
function detectViteApiEnvs(dir: string): { name: string; url: string }[] {
  const files = ['.env', '.env.example', '.env.local', '.env.development']
  const out: { name: string; url: string }[] = []
  const seen = new Set<string>()
  for (const f of files) {
    const p = join(dir, f)
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(
        /^\s*(VITE_[A-Z0-9_]+)\s*=\s*["']?(https?:\/\/[^\s"']*(?:localhost|127\.0\.0\.1)[^\s"']*)["']?\s*$/)
      if (m && !seen.has(m[1])) { seen.add(m[1]); out.push({ name: m[1], url: m[2] }) }
    }
  }
  return out
}
```

- [ ] **Step 4: buildConfigDraft 对 vite 追加 envs**

`src/cli/commands/init.ts` 的 `buildConfigDraft` 里，定位到 for 循环内推完 `type/port_base/dir` 与 fastapi app 注释、worker stub 之后、`base += 100` 之前，插入 vite 分支。

具体：在 `for (const s of services) {` 循环里，把现有这段：

```ts
    lines.push(`  ${s.name}:`, `    type: ${s.type}`, `    port_base: ${base}`, `    dir: ${s.dir}`)
    if (s.type === 'fastapi') lines.push(`    # app: app.main:app   # TODO fastapi 入口`)
    for (const lib of detectWorkerLibs(join(projectDir, s.dir))) {
      lines.push(
        `  # ${s.name}_worker:`,
        `  #   type: ${lib}`,
        `  #   dir: ${s.dir}`,
        `  #   app: app.worker   # TODO 填 ${lib === 'arq' ? 'WorkerSettings 所在模块' : 'celery app 模块'}`)
    }
    base += 100
```

替换为：

```ts
    lines.push(`  ${s.name}:`, `    type: ${s.type}`, `    port_base: ${base}`, `    dir: ${s.dir}`)
    if (s.type === 'fastapi') lines.push(`    # app: app.main:app   # TODO fastapi 入口`)
    if (s.type === 'vite') {
      const target = services.find(x => x.type !== 'vite')?.name ?? 'backend'
      const detected = detectViteApiEnvs(join(projectDir, s.dir))
      if (detected.length) {
        lines.push('    envs:')
        for (const e of detected)
          lines.push(`      ${e.name}: ${e.url.replace(/:(\d+)/, `:{${target}.port}`)}`)
      } else {
        lines.push(
          '    # envs:                                        # 取消注释并按需填写',
          `    #   VITE_API_BASE: http://localhost:{${target}.port}`)
      }
    }
    for (const lib of detectWorkerLibs(join(projectDir, s.dir))) {
      lines.push(
        `  # ${s.name}_worker:`,
        `  #   type: ${lib}`,
        `  #   dir: ${s.dir}`,
        `  #   app: app.worker   # TODO 填 ${lib === 'arq' ? 'WorkerSettings 所在模块' : 'celery app 模块'}`)
    }
    base += 100
```

- [ ] **Step 5: 跑测试确认通过（含原有 init 用例不回归）+ 类型检查**

Run: `npx vitest run tests/cli/init.test.ts && npm run typecheck`
Expected: PASS（含原"侦测 backend=django、frontend=vite"等用例）

- [ ] **Step 6: 提交**

```bash
git add src/cli/commands/init.ts tests/cli/init.test.ts
git commit -m "feat(init): vite 探测 .env* 自动写 envs（命中搬值/未命中注释 stub）"
```

---

## Task 7: README 文档更新

**Files:**
- Modify: `README.md`（services 示例区块、第 131-145 行 `.env` 注入章节）

**Interfaces:**
- 无代码接口；文档须与新行为一致。

- [ ] **Step 1: 更新 services 示例，给 frontend 加 envs**

`README.md` 的 services 示例里，`frontend` 块（原为）：

```yaml
  frontend:
    type: vite
    port_base: 10100
    dir: frontend
```

改为：

```yaml
  frontend:
    type: vite
    port_base: 10100
    dir: frontend
    envs:                                   # 前端要写进 .env 的变量（值支持占位符）
      VITE_API_BASE: http://localhost:{backend.port}
```

- [ ] **Step 2: 重写 `.env` 注入章节**

把"`bk allocate` 时……往每个 service 目录的 `.env` 里写入一个标记块"那段（含示例块与其后的要点列表，约第 131-145 行）替换为下面内容：

```markdown
`bk allocate` 时（即 `bk worktree create` 一步到位时），bk 往**每个 service 目录**（`dir`，缺省为 worktree 根）的 `.env` 写入一个**标记块**，只动块内、绝不碰你已有的 secrets。**写什么按 service 量身定制**：

后端（django/fastapi，及同目录的 arq/celery worker）目录里：

\`\`\`
# >>> bk managed >>>
BK_DB_NAME=foo_2
BK_REDIS_DB=2
BK_MINIO_BUCKET=foo-2
# <<< bk managed <<<
\`\`\`

前端（vite）目录里只写你在 `envs` 里声明的变量（占位符已插值）：

\`\`\`
# >>> bk managed >>>
VITE_API_BASE=http://localhost:10001
# <<< bk managed <<<
\`\`\`

- **后端只写动态隔离标识**——数据库名、Redis db 号、MinIO 桶名。主机/端口/账号密码这些共享静态连接信息不归 bk 管，留在你自己 `.env` 的 secrets 里（块外，bk 绝不触碰）。
- **前端写 `envs`**：在 vite service 上声明 `envs` 映射，值里可用占位符 `{<服务名>.port}` 引用某 service 的已分配端口（如 `{backend.port}`）。bk 在 allocate 时插值后写入。**vite 不写任何 `BK_` 变量**；**没写 `envs` 就什么都不写**。
- **占位符**：首批支持 `{<服务名>.port}`；引用了不存在或无 `port_base` 的服务名会报 `CONFIG_INVALID`。
- **`bk init` 会探测前端**：扫前端目录的 `.env`/`.env.example`/`.env.local`/`.env.development`，命中 `VITE_*=http://...localhost...` 就把变量名与格式搬进 `envs`（端口替换成 `{backend.port}`）；探不到则留一段注释掉的 `envs` stub 供你启用。
- **监听端口仍走启动命令参数**（各框架原生读各自目录下的 `.env`）。
- **写在每个 service 的目录里**：同目录多个 service（如后端 + worker）共用一份，env 需求合并。
- `.env` 含本机私有分配值，`bk init` 会把它加进 `.gitignore`。
```

（注意：上面代码块里的 \` 三连转义在实际写入 README 时是普通的 ``` 围栏。）

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs(readme): per-service .env 注入、envs 字段与占位符语法"
```

---

## 自查（写完计划后对照 spec）

- **spec §1 envs 字段** → Task 1。
- **spec §2 占位符插值** → Task 2（含未知服务名报错）。
- **spec §3 类型默认 + envs 叠加、vite 无 envs 不写** → Task 3（adapter.envVars）+ Task 4（buildDirEnvs 合并、空块跳过 + 对应测试）。
- **spec §4 bk init 探测** → Task 6（命中搬值/未命中注释 stub）。
- **spec §5 写入与合并、标记块/去重/gitignore 不变** → Task 4（writeServiceEnvs 按目录合并；removeServiceEnvs 与 gitignore 不动）。
- **spec §6 provider.envVars 归宿** → Task 3（backendEnvVars）+ Task 5（删 provider.envVars + planNames 取代 collectEnv）。
- **spec §7 边界报错** → Task 2（占位符报错路径）。
- **spec 测试清单** → 各 Task 的测试步骤覆盖；回归适配在 Task 4/5。
- **spec 文档** → Task 7。

类型一致性核对：`planNames`/`buildDirEnvs`/`writeServiceEnvs(ctx,worktreeDir,names)`/`interpolateEnvs(envs,names,svcName)`/`backendEnvVars(names)`/`adapter.envVars(names)` 在各 Task 间签名一致。无占位符/TODO 残留。
