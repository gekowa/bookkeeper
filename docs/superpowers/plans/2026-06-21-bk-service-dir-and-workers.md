# BookKeeper service 目录 + arq/celery worker 支持 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `bk start` 在每个 service 自己的目录里启动命令，并支持无端口的 arq/celery worker 在 pane 中启动。

**Architecture:** 给 `ServiceConfig` 加 `dir` 字段表达服务子目录；用"不写 `port_base`"自然表达"无端口"，让 port provider 跳过 worker；新增 arq/celery 两个 framework adapter 提供默认启动命令；`buildLaunchSpecs` 用 `dir` 解析 cwd 并支持无端口分支。

**Tech Stack:** TypeScript (ESM, `.js` 导入后缀)、Vitest、commander、yaml。测试命令 `npx vitest run <path>`，类型检查 `npm run typecheck`。

## Global Constraints

- 所有内部导入使用 `.js` 后缀（ESM + tsup），如 `import { foo } from '../core/errors.js'`。
- 错误一律用 `BkError`，错误码取自 `src/core/errors.ts` 的 `Codes`；本计划只用到 `Codes.CONFIG_INVALID`。
- 用户面向文案保持中文（与现有代码一致，禁止日文）。
- 测试文件放 `tests/` 下，命名 `*.test.ts`，用 `import { describe, it, expect } from 'vitest'`。
- arq 默认命令：`uv run arq <app>.WorkerSettings`；celery 默认命令：`uv run celery -A <app> worker`（已与用户确认）。

---

### Task 1: 扩展类型 + config/load 支持 worker（无 port_base）与 dir 透传

**Files:**
- Modify: `src/core/types.ts:1`（`ServiceType` 联合）、`src/core/types.ts:4-10`（`ServiceConfig`）
- Modify: `src/config/load.ts:11-15`
- Test: `tests/config/load.test.ts`

**Interfaces:**
- Produces:
  - `ServiceType = 'django' | 'fastapi' | 'vite' | 'arq' | 'celery'`
  - `ServiceConfig { name: string; type: ServiceType; port_base?: number; command?: string; app?: string; dir?: string }`
  - `loadConfig(projectRoot: string): ProjectConfig` — 行为变更：`port_base` 缺省时不再抛错（视为无端口 service）；`port_base` 存在但非 number 时抛 `CONFIG_INVALID`；透传 `dir`。

- [ ] **Step 1: 改类型**

`src/core/types.ts` 第 1 行改为：

```ts
export type ServiceType = 'django' | 'fastapi' | 'vite' | 'arq' | 'celery'
```

`src/core/types.ts` 的 `ServiceConfig` 改为：

```ts
export interface ServiceConfig {
  name: string
  type: ServiceType
  port_base?: number
  command?: string
  app?: string
  dir?: string
}
```

- [ ] **Step 2: 改 load 测试（先让它失败）**

在 `tests/config/load.test.ts` 中，把原有的 `it('service 缺 port_base 抛 CONFIG_INVALID', ...)` 整段（约 47-55 行）**替换**为以下三个用例：

```ts
  it('service 无 port_base 视为 worker，正常加载', () => {
    write(`project_name: foo
services:
  worker:
    type: arq
    dir: backend
    app: app.worker
infra: {}
`)
    const c = loadConfig(root)
    expect(c.services[0].name).toBe('worker')
    expect(c.services[0].port_base).toBeUndefined()
    expect(c.services[0].dir).toBe('backend')
  })
  it('port_base 存在但非数字 → 抛 CONFIG_INVALID', () => {
    write(`project_name: foo
services:
  backend:
    type: django
    port_base: not-a-number
infra: {}
`)
    expect(() => loadConfig(root)).toThrow(/port_base/)
  })
  it('透传 dir 字段', () => {
    write(`project_name: foo
services:
  backend:
    type: django
    port_base: 10000
    dir: backend
infra: {}
`)
    expect(loadConfig(root).services[0].dir).toBe('backend')
  })
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/config/load.test.ts`
Expected: 新增三个用例中至少 "无 port_base 视为 worker" 失败（当前代码对缺 port_base 抛错）。

- [ ] **Step 4: 改 load 实现**

`src/config/load.ts` 的 `.map` 回调（11-15 行）改为：

```ts
  const services: ServiceConfig[] = Object.entries<any>(servicesObj).map(([name, s]) => {
    if (!s?.type) throw new BkError(Codes.CONFIG_INVALID, `service ${name} 缺少 type`)
    if (s.port_base !== undefined && typeof s.port_base !== 'number')
      throw new BkError(Codes.CONFIG_INVALID, `service ${name} 的 port_base 必须是数字`)
    return { name, type: s.type, port_base: s.port_base, command: s.command, app: s.app, dir: s.dir }
  })
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/config/load.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 6: 提交**

```bash
git add src/core/types.ts src/config/load.ts tests/config/load.test.ts
git commit -m "feat(config): port_base 可选（worker 无端口）+ 透传 dir + arq/celery 类型"
```

---

### Task 2: framework adapter 的 `defaultStartCommand` port 参数可选，有端口 adapter 缺 port 时报错

**Files:**
- Modify: `src/frameworks/types.ts:6`
- Modify: `src/frameworks/django.ts`、`src/frameworks/vite.ts`、`src/frameworks/fastapi.ts`
- Test: `tests/frameworks/command.test.ts`

**Interfaces:**
- Consumes: `ServiceConfig`（Task 1）
- Produces: `FrameworkAdapter.defaultStartCommand(svc: ServiceConfig, port?: number): string`。django/vite/fastapi 在 `port === undefined` 时抛 `CONFIG_INVALID`。

- [ ] **Step 1: 写失败测试**

在 `tests/frameworks/command.test.ts` 的 `describe` 内追加：

```ts
  it('django 缺端口 → 抛 CONFIG_INVALID', () => {
    expect(() => adapterFor('django').defaultStartCommand({ name: 'b', type: 'django' }))
      .toThrow(/CONFIG_INVALID|端口|port/)
  })
  it('vite 缺端口 → 抛 CONFIG_INVALID', () => {
    expect(() => adapterFor('vite').defaultStartCommand({ name: 'f', type: 'vite' }))
      .toThrow(/CONFIG_INVALID|端口|port/)
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/frameworks/command.test.ts`
Expected: FAIL（当前 django 返回 `...0.0.0.0:undefined`，不抛错）

- [ ] **Step 3: 改接口签名**

`src/frameworks/types.ts` 第 6 行改为：

```ts
  defaultStartCommand(svc: ServiceConfig, port?: number): string
```

- [ ] **Step 4: 改 django.ts**

`src/frameworks/django.ts` 整体改为：

```ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'

export const django: FrameworkAdapter = {
  type: 'django',
  detect: (dir) => existsSync(join(dir, 'manage.py')),
  defaultStartCommand: (_svc, port) => {
    if (port === undefined) throw new BkError(Codes.CONFIG_INVALID, 'django service 需要端口（设置 port_base）')
    return `uv run python manage.py runserver 0.0.0.0:${port}`
  },
}
```

- [ ] **Step 5: 改 vite.ts**

`src/frameworks/vite.ts` 整体改为：

```ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'

export const vite: FrameworkAdapter = {
  type: 'vite',
  detect: (dir) => ['vite.config.ts', 'vite.config.js'].some(f => existsSync(join(dir, f))),
  defaultStartCommand: (_svc, port) => {
    if (port === undefined) throw new BkError(Codes.CONFIG_INVALID, 'vite service 需要端口（设置 port_base）')
    return `npm run dev -- --port ${port}`
  },
}
```

- [ ] **Step 6: 改 fastapi.ts**

`src/frameworks/fastapi.ts` 的 `defaultStartCommand` 改为（在 app 检查之后增加 port 检查）：

```ts
  defaultStartCommand: (svc, port) => {
    if (!svc.app) throw new BkError(Codes.CONFIG_INVALID,
      `fastapi service ${svc.name} 需在 config 设置 app（如 app.main:app）或 command`)
    if (port === undefined) throw new BkError(Codes.CONFIG_INVALID,
      `fastapi service ${svc.name} 需要端口（设置 port_base）`)
    return `uv run uvicorn ${svc.app} --port ${port}`
  },
```

- [ ] **Step 7: 运行确认通过**

Run: `npx vitest run tests/frameworks/command.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/frameworks/types.ts src/frameworks/django.ts src/frameworks/vite.ts src/frameworks/fastapi.ts tests/frameworks/command.test.ts
git commit -m "feat(frameworks): defaultStartCommand port 可选，有端口 adapter 缺 port 时报错"
```

---

### Task 3: 新增 arq + celery adapter 并注册

**Files:**
- Create: `src/frameworks/arq.ts`、`src/frameworks/celery.ts`
- Modify: `src/frameworks/registry.ts:6-8`
- Test: `tests/frameworks/command.test.ts`、`tests/frameworks/detect.test.ts`

**Interfaces:**
- Consumes: `FrameworkAdapter`（Task 2 的签名）、`ServiceConfig`（Task 1）
- Produces: `arq`、`celery` 两个 `FrameworkAdapter`，`detect` 恒为 `false`；`adapterFor('arq')` / `adapterFor('celery')` 可用。

- [ ] **Step 1: 写失败测试**

在 `tests/frameworks/command.test.ts` 追加：

```ts
  it('arq 用 app 字段', () => expect(adapterFor('arq').defaultStartCommand({ name: 'w', type: 'arq', app: 'app.worker' }))
    .toBe('uv run arq app.worker.WorkerSettings'))
  it('celery 用 app 字段', () => expect(adapterFor('celery').defaultStartCommand({ name: 'w', type: 'celery', app: 'app.celery' }))
    .toBe('uv run celery -A app.celery worker'))
  it('arq 缺 app → 抛 CONFIG_INVALID', () => {
    expect(() => adapterFor('arq').defaultStartCommand({ name: 'w', type: 'arq' })).toThrow(/CONFIG_INVALID|app/)
  })
  it('celery 缺 app → 抛 CONFIG_INVALID', () => {
    expect(() => adapterFor('celery').defaultStartCommand({ name: 'w', type: 'celery' })).toThrow(/CONFIG_INVALID|app/)
  })
```

在 `tests/frameworks/detect.test.ts` 追加（worker 不参与目录侦测）：

```ts
  it('arq/celery adapter detect 恒为 false（不污染目录侦测）', async () => {
    const { arq } = await import('../../src/frameworks/arq.js')
    const { celery } = await import('../../src/frameworks/celery.js')
    expect(arq.detect(fx('fastapi-proj'))).toBe(false)
    expect(celery.detect(fx('fastapi-proj'))).toBe(false)
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/frameworks/command.test.ts tests/frameworks/detect.test.ts`
Expected: FAIL（`adapterFor('arq')` 抛"未知 type"；arq.ts 模块不存在）

- [ ] **Step 3: 建 arq.ts**

创建 `src/frameworks/arq.ts`：

```ts
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'

export const arq: FrameworkAdapter = {
  type: 'arq',
  detect: () => false,
  defaultStartCommand: (svc) => {
    if (!svc.app) throw new BkError(Codes.CONFIG_INVALID,
      `arq service ${svc.name} 需在 config 设置 app（如 app.worker）或 command`)
    return `uv run arq ${svc.app}.WorkerSettings`
  },
}
```

- [ ] **Step 4: 建 celery.ts**

创建 `src/frameworks/celery.ts`：

```ts
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'

export const celery: FrameworkAdapter = {
  type: 'celery',
  detect: () => false,
  defaultStartCommand: (svc) => {
    if (!svc.app) throw new BkError(Codes.CONFIG_INVALID,
      `celery service ${svc.name} 需在 config 设置 app（如 app.celery）或 command`)
    return `uv run celery -A ${svc.app} worker`
  },
}
```

- [ ] **Step 5: 注册到 registry**

`src/frameworks/registry.ts` 第 4-8 行改为：

```ts
import { django } from './django.js'
import { fastapi } from './fastapi.js'
import { vite } from './vite.js'
import { arq } from './arq.js'
import { celery } from './celery.js'

const ALL: FrameworkAdapter[] = [django, fastapi, vite, arq, celery]
```

- [ ] **Step 6: 运行确认通过**

Run: `npx vitest run tests/frameworks/command.test.ts tests/frameworks/detect.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/frameworks/arq.ts src/frameworks/celery.ts src/frameworks/registry.ts tests/frameworks/command.test.ts tests/frameworks/detect.test.ts
git commit -m "feat(frameworks): 新增 arq/celery worker adapter（无端口、detect 恒 false）"
```

---

### Task 4: port provider 跳过无 port_base 的 worker

**Files:**
- Modify: `src/providers/port.ts:14-16`
- Test: `tests/providers/port.test.ts`

**Interfaces:**
- Consumes: `ServiceConfig.port_base?`（Task 1）
- Produces: `createPortProvider()` 的 `plan` / `probe` 只覆盖有 `port_base` 的 service。

- [ ] **Step 1: 写失败测试**

在 `tests/providers/port.test.ts` 追加：

```ts
  it('plan 跳过无 port_base 的 worker', () => {
    const c: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
      services: [
        { name: 'backend', type: 'django', port_base: 10000 },
        { name: 'worker', type: 'arq', app: 'app.worker' },
      ] } }
    expect(createPortProvider().plan(2, c).ports).toEqual({ backend: 10002 })
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/providers/port.test.ts`
Expected: FAIL（worker 当前会得到 `port_base + n` = `NaN`，结果含 `worker: NaN`）

- [ ] **Step 3: 改实现**

`src/providers/port.ts` 的 `ports` 函数（14-16 行）改为：

```ts
  const ports = (n: number, ctx: Ctx) =>
    Object.fromEntries(
      ctx.config.services
        .filter(s => s.port_base !== undefined)
        .map(s => [s.name, (s.port_base as number) + n]))
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/providers/port.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/providers/port.ts tests/providers/port.test.ts
git commit -m "feat(providers): port provider 跳过无 port_base 的 worker"
```

---

### Task 5: buildLaunchSpecs 用 dir 解析 cwd + 支持无端口 service

**Files:**
- Modify: `src/launch/index.ts:1-20`
- Test: `tests/cli/start.test.ts`

**Interfaces:**
- Consumes: `ServiceConfig.dir?`（Task 1）、`adapterFor(type).defaultStartCommand(svc, port?)`（Task 2/3）
- Produces: `buildLaunchSpecs(ctx, set, worktreeDir, only?)` —
  - cwd = `join(worktreeDir, s.dir ?? '.')`
  - 无端口 service（`set.resources[s.name]` 无 port）：传 `undefined` 给 adapter，命令不含 port
  - 用户 `command` 含 `{port}` 但无端口 → 抛 `CONFIG_INVALID`

- [ ] **Step 1: 写失败测试**

在 `tests/cli/start.test.ts` 追加（顶部已 import `buildLaunchSpecs`、`Ctx`、`SetRecord`）：

```ts
  it('用 dir 解析 cwd', () => {
    const ctxDir: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
      services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend' }] } }
    const setDir: SetRecord = { status: 'allocated', owner: { worktree: '/wt', branch: 'x' },
      resources: { backend: { port: 10002 } }, created_at: 'x' }
    expect(buildLaunchSpecs(ctxDir, setDir, '/wt')[0].cwd).toBe('/wt/backend')
  })
  it('无端口 worker：用 adapter 默认命令、cwd 取 dir', () => {
    const ctxW: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
      services: [{ name: 'worker', type: 'arq', app: 'app.worker', dir: 'backend' }] } }
    const setW: SetRecord = { status: 'allocated', owner: { worktree: '/wt', branch: 'x' },
      resources: {}, created_at: 'x' }
    const spec = buildLaunchSpecs(ctxW, setW, '/wt')[0]
    expect(spec.command).toBe('uv run arq app.worker.WorkerSettings')
    expect(spec.cwd).toBe('/wt/backend')
  })
  it('command 含 {port} 但无端口 → 抛 CONFIG_INVALID', () => {
    const ctxBad: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
      services: [{ name: 'worker', type: 'arq', command: 'run --port {port}', dir: 'backend' }] } }
    const setBad: SetRecord = { status: 'allocated', owner: { worktree: '/wt', branch: 'x' },
      resources: {}, created_at: 'x' }
    expect(() => buildLaunchSpecs(ctxBad, setBad, '/wt')).toThrow(/CONFIG_INVALID|port/)
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/cli/start.test.ts`
Expected: FAIL（cwd 当前恒为 `/wt`；worker 读 `set.resources['worker'].port` 抛 TypeError）

- [ ] **Step 3: 改实现**

`src/launch/index.ts` 顶部 import 区加入：

```ts
import { join } from 'node:path'
import { BkError, Codes } from '../core/errors.js'
```

把 `buildLaunchSpecs`（10-20 行）整体改为：

```ts
export function buildLaunchSpecs(ctx: Ctx, set: SetRecord, worktreeDir: string, only?: string): LaunchSpec[] {
  return ctx.config.services
    .filter(s => !only || s.name === only)
    .map(s => {
      const port = (set.resources[s.name] as { port: number } | undefined)?.port
      let command: string
      if (s.command) {
        if (s.command.includes('{port}') && port === undefined)
          throw new BkError(Codes.CONFIG_INVALID,
            `service ${s.name} 无端口但 command 引用了 {port}`,
            { remediation: '移除 {port} 或为该 service 设置 port_base' })
        command = s.command.replace(/\{port\}/g, String(port))
      } else {
        command = adapterFor(s.type).defaultStartCommand(s, port)
      }
      return { name: s.name, command, cwd: join(worktreeDir, s.dir ?? '.') }
    })
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/cli/start.test.ts`
Expected: PASS（含原有 "cwd 为 /wt" 用例——`join('/wt', '.')` === `/wt`）

- [ ] **Step 5: 提交**

```bash
git add src/launch/index.ts tests/cli/start.test.ts
git commit -m "feat(launch): buildLaunchSpecs 用 dir 解析 cwd + 支持无端口 worker"
```

---

### Task 6: bk init 写出 dir + 侦测 worker 依赖输出注释 stub

**Files:**
- Modify: `src/cli/commands/init.ts:10-32`
- Test: `tests/cli/init.test.ts`

**Interfaces:**
- Consumes: `detectType`（不变）
- Produces: `buildConfigDraft(projectDir)` 为每个 service 写 `dir:` 行；当 python service 目录 `pyproject.toml` 含 `arq`/`celery` 依赖时，在该 service 之后追加注释 worker stub。

- [ ] **Step 1: 写失败测试**

在 `tests/cli/init.test.ts` 第一个用例 `侦测 backend=django、frontend=vite` 的末尾追加两行断言：

```ts
    expect(yml).toMatch(/backend:[\s\S]*dir: backend/)
    expect(yml).toMatch(/frontend:[\s\S]*dir: frontend/)
```

再在 `describe` 内追加新用例：

```ts
  it('pyproject 含 arq 依赖 → 输出注释 worker stub', () => {
    const wdir = mkdtempSync(join(tmpdir(), 'proj-'))
    try {
      mkdirSync(join(wdir, 'backend'))
      writeFileSync(join(wdir, 'backend', 'pyproject.toml'),
        '[project]\ndependencies = ["fastapi>=0.100", "arq>=0.25"]\n')
      const yml = buildConfigDraft(wdir)
      expect(yml).toMatch(/backend:[\s\S]*type: fastapi/)
      expect(yml).toContain('#   type: arq')
      expect(yml).toContain('#   dir: backend')
    } finally {
      rmSync(wdir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/cli/init.test.ts`
Expected: FAIL（当前不写 `dir:`，也无 worker stub）

- [ ] **Step 3: 改实现**

`src/cli/commands/init.ts` 顶部 import 区把 `readdirSync, statSync` 那行补上 `readFileSync`：

```ts
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
```

把 `buildConfigDraft`（10-32 行）整体改为：

```ts
function detectWorkerLibs(dir: string): ('arq' | 'celery')[] {
  const p = join(dir, 'pyproject.toml')
  if (!existsSync(p)) return []
  const text = readFileSync(p, 'utf8')
  const libs: ('arq' | 'celery')[] = []
  if (/\barq\b/.test(text)) libs.push('arq')
  if (/\bcelery\b/.test(text)) libs.push('celery')
  return libs
}

export function buildConfigDraft(projectDir: string): string {
  const subdirs = readdirSync(projectDir)
    .filter(d => { try { return statSync(join(projectDir, d)).isDirectory() } catch { return false } })
  const detected: { name: string; type: string | null; dir: string }[] = []
  const rootType = detectType(projectDir)
  if (rootType) detected.push({ name: basename(projectDir), type: rootType, dir: '.' })
  for (const d of subdirs) detected.push({ name: d, type: detectType(join(projectDir, d)), dir: d })
  const services = detected.filter(d => d.type)

  const lines = ['---', `project_name: ${basename(projectDir)}`, '', 'services:']
  let base = 10000
  for (const s of services) {
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
  }
  if (!services.length) lines.push('  # TODO 未侦测到 service，请手动填写')
  lines.push('', 'infra:',
    '  postgres: { host: localhost, port: 5432, username: postgres, password: postgres }',
    '  redis: { host: localhost, port: 6379, isolation: key_prefix }',
    '  minio: { endpoint: localhost:9000, access_key: minioadmin, secret_key: minioadmin }')
  return lines.join('\n') + '\n'
}
```

注意：`join(projectDir, '.')` 等于 `projectDir`，根级 service 的 worker 侦测也能正确读到根 `pyproject.toml`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/cli/init.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/cli/commands/init.ts tests/cli/init.test.ts
git commit -m "feat(cli): bk init 写出 dir + 侦测 arq/celery 依赖输出注释 worker stub"
```

---

### Task 7: 全量回归 + 类型检查

**Files:** 无新增改动；仅验证。

- [ ] **Step 1: 跑全部测试**

Run: `npm test`
Expected: 全绿（含未触及的 redis/postgres/minio 等用例；集成测试若依赖 testcontainers 不可用而跳过/失败属环境问题，确认非本次改动引入）。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。重点确认 `port_base?` 改动未在别处留下"可能 undefined"的类型漏洞。

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: tsup 成功产出 `dist/`。

- [ ] **Step 4: 若前述全绿，无需额外提交**（各 Task 已分别提交）。

---

## Self-Review

**Spec coverage：**
- 问题1 service 目录：`dir` 字段（Task 1 types/load）、init 写出（Task 6）、buildLaunchSpecs 用 dir（Task 5）✓
- 问题2 arq/celery adapter：Task 3 ✓；默认命令与 spec 一致 ✓
- 无端口 = 无 port_base：load 放宽（Task 1）、port provider 跳过（Task 4）、buildLaunchSpecs 无端口分支（Task 5）✓
- adapter port 可选 + 有端口 adapter 缺 port 报错：Task 2 ✓
- worker adapter detect 恒 false：Task 3 ✓
- init 侦测 worker 依赖输出注释 stub：Task 6 ✓
- 启动器三策略不改：确认无改动 ✓
- bk list 不改：确认无 list 改动 ✓
- 测试覆盖 spec "测试"节列出的全部点 ✓

**Placeholder scan：** 计划内出现的 `# TODO` / `# app:` 均为**生成产物中的字面内容**（init 写入 yml 的注释），非计划占位符。计划步骤本身无 TBD/TODO/"类似 Task N" 等占位。✓

**Type consistency：** `defaultStartCommand(svc, port?)` 签名在 Task 2 定义、Task 3/5 一致使用；`ServiceConfig.port_base?`、`dir?` 在 Task 1 定义、Task 4/5/6 一致引用；`detectWorkerLibs` 仅 Task 6 内部使用。✓
