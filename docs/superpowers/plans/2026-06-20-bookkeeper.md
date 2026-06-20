# BookKeeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 `bk`——一个 strongly-opinionated 的 Node/TS CLI，为并行 git worktree 分配、注入、回收本地逻辑资源（端口、Postgres 库、Redis 命名空间、MinIO 桶）。

**Architecture:** 单向分层 `cli → core → {providers, frameworks, state, inject, launch, git} → config`。两大抽象：`ResourceProvider`（infra 资源，有 provision/destroy 副作用）和 `FrameworkAdapter`（服务，仅 detect + 算启动命令）。state.json 存固化解析值，项目级文件锁 + 原子写。错误用 `BkError{recoverable}` 分流"跳号重试" vs "回滚中止"。

**Tech Stack:** TypeScript (ESM, NodeNext)、commander（CLI）、yaml、pg、ioredis、minio、proper-lockfile、execa（spawn/git）、@inquirer/prompts（确认）、tsup（打包 bin）、vitest（测试）、testcontainers（provider 集成测）。

## Global Constraints

- 语言/运行时：Node ≥ 20，TypeScript ESM（`"type": "module"`，`module/moduleResolution: NodeNext`）。
- 包名 `bookkeeper`，CLI 命令 `bk`，bin 入口含 `#!/usr/bin/env node`。
- 资源命名（统一编号 N，从 1 起）：后端口 `port_base+N`、前端口 `port_base+N`、Postgres 库 `<project>_<N>`、Redis 前缀 `<project>_<N>_`、MinIO 桶 `<project>-<N>`（下划线转连字符）。
- state.json 位置：`~/.bookkeeper/<project_name>/state.json`；锁文件 `~/.bookkeeper/<project_name>/lock`。
- `.env` 注入用标记块 `# >>> bk managed >>>` … `# <<< bk managed <<<`，绝不碰块外内容。
- 跳号上限默认 20（config 可覆盖 `allocation.max_probe_attempts`）。
- 退出码：0 成功、1 致命错、2 用法错。
- Python 启动命令一律用 `uv`。
- 首批支持框架：django、fastapi、vite；首批 infra：postgres、redis（key_prefix/db_number 双模式）、minio。
- 所有 BK_* env 变量名固定：`BK_DB_HOST/PORT/USER/PASSWORD/NAME`、`BK_REDIS_HOST/PORT/PREFIX`（db_number 模式额外 `BK_REDIS_DB`）、`BK_MINIO_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET`。
- 测试：单测用 fake provider/adapter；provider 集成测打 `// @integration`（vitest 用 `test.runIf(hasDocker)`）。

---

## File Structure

```
package.json, tsconfig.json, tsup.config.ts, vitest.config.ts
src/
  cli/index.ts                 commander 装配 + bin 入口
  cli/commands/{init,allocate,deallocate,worktree,list,start,destroy}.ts
  cli/output.ts                统一输出/颜色/确认封装
  core/types.ts                Ctx、ResourceNames、SetRecord 等共享类型
  core/errors.ts               BkError + code 常量
  core/allocator.ts            allocate 编排（选号/探活/provision/回滚）
  core/deallocator.ts          deallocate
  core/destroyer.ts            destroy（护栏）
  core/numbering.ts            选号：最小空闲号/复用 free set
  providers/types.ts           ResourceProvider 接口
  providers/registry.ts        据 config 组装启用的 provider 列表
  providers/port.ts
  providers/postgres.ts
  providers/redis.ts
  providers/minio.ts
  frameworks/types.ts          FrameworkAdapter 接口
  frameworks/registry.ts
  frameworks/{django,fastapi,vite}.ts
  state/store.ts               读/写/锁/原子 rename
  state/schema.ts              StateFile 类型 + 校验
  config/load.ts               加载/校验 bk_config.yml
  config/discover.ts           向上查找项目根
  config/fingerprint.ts        config_fingerprint
  inject/env.ts                .env 标记块读-合并-写
  inject/gitignore.ts          .gitignore 维护
  launch/index.ts              start 策略选择
  launch/tmux.ts, launch/iterm.ts, launch/print.ts
  git/worktree.ts              git worktree add/remove 封装
tests/                          镜像 src/ 结构
tests/fixtures/                 假项目目录（django/fastapi/vite）
tests/helpers/fakeProvider.ts
```

---

## Task 1: 项目脚手架与构建链

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`, `src/cli/index.ts`

**Interfaces:**
- Produces: 可运行的 `bk` bin（打印帮助）；`npm test` / `npm run build` 可用。

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "bookkeeper",
  "version": "0.0.1",
  "type": "module",
  "bin": { "bk": "dist/cli/index.js" },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/cli/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@inquirer/prompts": "^7.0.0",
    "commander": "^12.0.0",
    "execa": "^9.0.0",
    "ioredis": "^5.4.0",
    "minio": "^8.0.0",
    "pg": "^8.12.0",
    "proper-lockfile": "^4.1.2",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "@types/proper-lockfile": "^4.1.4",
    "testcontainers": "^10.13.0",
    "tsup": "^8.3.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json / tsup.config.ts / vitest.config.ts**

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "outDir": "dist", "rootDir": "src", "declaration": false
  },
  "include": ["src"]
}
```

```ts
// tsup.config.ts
import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['esm'], target: 'node20', clean: true,
  banner: { js: '#!/usr/bin/env node' },
})
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], globals: false } })
```

- [ ] **Step 3: 写 .gitignore 与最小 CLI 入口**

```
# .gitignore
node_modules/
dist/
```

```ts
// src/cli/index.ts
import { Command } from 'commander'
const program = new Command()
program.name('bk').description('BookKeeper — 并行 worktree 的本地资源记账员').version('0.0.1')
program.parseAsync(process.argv)
```

- [ ] **Step 4: 安装依赖并验证 bin 运行**

Run: `npm install && npm run dev -- --help`
Expected: 打印 `Usage: bk ...` 帮助文本，退出 0。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsup.config.ts vitest.config.ts .gitignore src/cli/index.ts
git commit -m "chore: 项目脚手架（TS ESM + tsup + vitest + commander）"
```

---

## Task 2: 共享类型与错误模型

**Files:**
- Create: `src/core/types.ts`, `src/core/errors.ts`
- Test: `tests/core/errors.test.ts`

**Interfaces:**
- Produces:
  - `ResourceNames`、`SetRecord`、`Ctx`、`ProjectConfig`、`ServiceConfig`、`InfraConfig` 类型。
  - `class BkError extends Error { code: string; recoverable: boolean; remediation?: string }`，构造 `new BkError(code, message, { recoverable, remediation })`。
  - 常量对象 `Codes`（`PORT_IN_USE`/`DB_EXISTS`/`INFRA_UNREACHABLE`/`PERMISSION_DENIED`/`REDIS_DB_EXHAUSTED`/`PROBE_EXHAUSTED`/`SET_IN_USE`/`CONFIG_INVALID`/`NOT_IN_WORKTREE`）。

- [ ] **Step 1: 写 types.ts（无逻辑，纯类型）**

```ts
// src/core/types.ts
export type ServiceType = 'django' | 'fastapi' | 'vite'
export type RedisIsolation = 'key_prefix' | 'db_number'

export interface ServiceConfig {
  name: string
  type: ServiceType
  port_base: number
  command?: string
  app?: string
}
export interface InfraConfig {
  postgres?: { host: string; port: number; username: string; password: string }
  redis?: { host: string; port: number; isolation: RedisIsolation }
  minio?: { endpoint: string; access_key: string; secret_key: string }
}
export interface ProjectConfig {
  project_name: string
  services: ServiceConfig[]
  infra: InfraConfig
  allocation?: { max_probe_attempts?: number }
}
export interface Ctx {
  config: ProjectConfig
  projectRoot: string   // main 仓库根（含 bk_config.yml）
}
export interface ResourceNames {
  ports: Record<string, number>      // serviceName -> port
  database?: string
  redisPrefix?: string
  redisDb?: number
  bucket?: string
}
export interface SetRecord {
  status: 'allocated' | 'free'
  owner: { worktree: string; branch: string } | null
  resources: {
    [service: string]: { port: number } | undefined
  } & {
    postgres?: { database: string }
    redis?: { prefix?: string; db?: number }
    minio?: { bucket: string }
  }
  created_at: string
}
```

- [ ] **Step 2: 写 errors.test.ts（失败测试）**

```ts
// tests/core/errors.test.ts
import { describe, it, expect } from 'vitest'
import { BkError, Codes } from '../../src/core/errors.js'

describe('BkError', () => {
  it('携带 code/recoverable/remediation', () => {
    const e = new BkError(Codes.INFRA_UNREACHABLE, 'Postgres 连不上', {
      recoverable: false, remediation: '启动你的本地数据库',
    })
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('INFRA_UNREACHABLE')
    expect(e.recoverable).toBe(false)
    expect(e.remediation).toBe('启动你的本地数据库')
  })
  it('recoverable 默认 false', () => {
    const e = new BkError(Codes.DB_EXISTS, 'x')
    expect(e.recoverable).toBe(false)
  })
})
```

- [ ] **Step 3: 运行测试验证失败**

Run: `npx vitest run tests/core/errors.test.ts`
Expected: FAIL（`errors.js` 不存在 / BkError undefined）。

- [ ] **Step 4: 写 errors.ts**

```ts
// src/core/errors.ts
export const Codes = {
  PORT_IN_USE: 'PORT_IN_USE', DB_EXISTS: 'DB_EXISTS',
  INFRA_UNREACHABLE: 'INFRA_UNREACHABLE', PERMISSION_DENIED: 'PERMISSION_DENIED',
  REDIS_DB_EXHAUSTED: 'REDIS_DB_EXHAUSTED', PROBE_EXHAUSTED: 'PROBE_EXHAUSTED',
  SET_IN_USE: 'SET_IN_USE', CONFIG_INVALID: 'CONFIG_INVALID',
  NOT_IN_WORKTREE: 'NOT_IN_WORKTREE',
} as const
export type Code = (typeof Codes)[keyof typeof Codes]

export class BkError extends Error {
  code: string
  recoverable: boolean
  remediation?: string
  constructor(code: string, message: string,
              opts: { recoverable?: boolean; remediation?: string } = {}) {
    super(message)
    this.name = 'BkError'
    this.code = code
    this.recoverable = opts.recoverable ?? false
    this.remediation = opts.remediation
  }
}
```

- [ ] **Step 5: 运行测试验证通过 + Commit**

Run: `npx vitest run tests/core/errors.test.ts` → PASS

```bash
git add src/core/types.ts src/core/errors.ts tests/core/errors.test.ts
git commit -m "feat(core): 共享类型与 BkError 错误模型"
```

---

## Task 3: config 加载、校验与项目根发现

**Files:**
- Create: `src/config/load.ts`, `src/config/discover.ts`, `src/config/fingerprint.ts`
- Test: `tests/config/load.test.ts`, `tests/config/discover.test.ts`

**Interfaces:**
- Consumes: `ProjectConfig`、`BkError`、`Codes`（Task 2）。
- Produces:
  - `loadConfig(projectRoot: string): ProjectConfig` —— 读 `bk_config.yml`，校验必填字段，非法抛 `BkError(CONFIG_INVALID)`。services 单键 map 归一化为带 `name` 的数组。
  - `discoverProjectRoot(startDir: string): string` —— 向上查找含 `bk_config.yml` 的目录；找不到抛 `BkError(CONFIG_INVALID)`。
  - `fingerprint(config: ProjectConfig): string` —— 稳定 `sha256:...`。

- [ ] **Step 1: 写 discover.test.ts**

```ts
// tests/config/discover.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverProjectRoot } from '../../src/config/discover.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bk-'))
  writeFileSync(join(root, 'bk_config.yml'), 'project_name: foo\n')
  mkdirSync(join(root, 'a', 'b'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('discoverProjectRoot', () => {
  it('从深层子目录向上找到根', () => {
    expect(discoverProjectRoot(join(root, 'a', 'b'))).toBe(root)
  })
  it('找不到时抛错', () => {
    expect(() => discoverProjectRoot(tmpdir())).toThrow(/bk_config\.yml/)
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/config/discover.test.ts` → FAIL

- [ ] **Step 3: 写 discover.ts**

```ts
// src/config/discover.ts
import { existsSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { BkError, Codes } from '../core/errors.js'

export function discoverProjectRoot(startDir: string): string {
  let dir = startDir
  const rootPath = parse(dir).root
  while (true) {
    if (existsSync(join(dir, 'bk_config.yml'))) return dir
    if (dir === rootPath) break
    dir = dirname(dir)
  }
  throw new BkError(Codes.CONFIG_INVALID,
    '未找到 bk_config.yml；请在项目内运行，或先 `bk init`。',
    { remediation: '在 main 仓库根运行 `bk init`' })
}
```

- [ ] **Step 4: 写 load.test.ts + load.ts + fingerprint.ts**

```ts
// tests/config/load.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/config/load.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bk-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

function write(yml: string) { writeFileSync(join(root, 'bk_config.yml'), yml) }

describe('loadConfig', () => {
  it('解析并归一化 services 为带 name 的数组', () => {
    write(`project_name: foo
services:
  backend:
    type: django
    port_base: 10000
  frontend:
    type: vite
    port_base: 10100
infra:
  postgres: { host: localhost, port: 5432, username: postgres, password: postgres }
  redis: { host: localhost, port: 6379, isolation: key_prefix }
  minio: { endpoint: localhost:9000, access_key: a, secret_key: b }
`)
    const c = loadConfig(root)
    expect(c.project_name).toBe('foo')
    expect(c.services.map(s => s.name)).toEqual(['backend', 'frontend'])
    expect(c.services[0].type).toBe('django')
    expect(c.infra.redis?.isolation).toBe('key_prefix')
  })
  it('缺 project_name 抛 CONFIG_INVALID', () => {
    write(`services: {}\n`)
    expect(() => loadConfig(root)).toThrow(/project_name/)
  })
})
```

```ts
// src/config/load.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { BkError, Codes } from '../core/errors.js'
import type { ProjectConfig, ServiceConfig } from '../core/types.js'

export function loadConfig(projectRoot: string): ProjectConfig {
  const raw = parse(readFileSync(join(projectRoot, 'bk_config.yml'), 'utf8')) ?? {}
  if (!raw.project_name) throw new BkError(Codes.CONFIG_INVALID, 'bk_config.yml 缺少 project_name')
  const servicesObj = raw.services ?? {}
  const services: ServiceConfig[] = Object.entries<any>(servicesObj).map(([name, s]) => {
    if (!s?.type) throw new BkError(Codes.CONFIG_INVALID, `service ${name} 缺少 type`)
    if (typeof s.port_base !== 'number') throw new BkError(Codes.CONFIG_INVALID, `service ${name} 缺少 port_base`)
    return { name, type: s.type, port_base: s.port_base, command: s.command, app: s.app }
  })
  return {
    project_name: raw.project_name,
    services,
    infra: raw.infra ?? {},
    allocation: raw.allocation,
  }
}
```

```ts
// src/config/fingerprint.ts
import { createHash } from 'node:crypto'
import type { ProjectConfig } from '../core/types.js'

export function fingerprint(config: ProjectConfig): string {
  const stable = JSON.stringify(config, Object.keys(config).sort())
  return 'sha256:' + createHash('sha256').update(stable).digest('hex')
}
```

- [ ] **Step 5: 运行全部 config 测试通过 + Commit**

Run: `npx vitest run tests/config` → PASS

```bash
git add src/config tests/config
git commit -m "feat(config): 加载/校验 bk_config.yml + 项目根发现 + fingerprint"
```

---

## Task 4: state 存储（锁 + 原子写）

**Files:**
- Create: `src/state/schema.ts`, `src/state/store.ts`
- Test: `tests/state/store.test.ts`

**Interfaces:**
- Consumes: `SetRecord`（Task 2）。
- Produces:
  - `interface StateFile { project_name: string; config_fingerprint: string; sets: Record<string, SetRecord> }`
  - `stateDir(project: string): string` → `~/.bookkeeper/<project>`
  - `async withState<T>(project: string, fn: (s: StateFile) => Promise<T> | T): Promise<T>` —— 加锁 → 读（不存在则初始化空）→ 调 fn（可改 s）→ 原子写 → 解锁 → 返回 fn 结果。
  - `async readState(project: string): Promise<StateFile>` —— 只读、不加锁（供 list）。

- [ ] **Step 1: 写 store.test.ts（用 BK_HOME 环境变量重定向 home）**

```ts
// tests/state/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withState, readState } from '../../src/state/store.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home })
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.BK_HOME })

describe('state store', () => {
  it('首次读返回空 sets 并可写入', async () => {
    await withState('foo', (s) => {
      expect(s.sets).toEqual({})
      s.project_name = 'foo'
      s.sets['1'] = { status: 'free', owner: null, resources: {}, created_at: 'x' }
    })
    const s = await readState('foo')
    expect(s.sets['1'].status).toBe('free')
  })
  it('并发 withState 串行化、不丢更新', async () => {
    await Promise.all([1, 2, 3].map(n =>
      withState('foo', (s) => { s.sets[String(n)] = { status: 'free', owner: null, resources: {}, created_at: 'x' } })
    ))
    const s = await readState('foo')
    expect(Object.keys(s.sets).sort()).toEqual(['1', '2', '3'])
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/state/store.test.ts` → FAIL

- [ ] **Step 3: 写 schema.ts + store.ts**

```ts
// src/state/schema.ts
import type { SetRecord } from '../core/types.js'
export interface StateFile {
  project_name: string
  config_fingerprint: string
  sets: Record<string, SetRecord>
}
export function emptyState(project: string): StateFile {
  return { project_name: project, config_fingerprint: '', sets: {} }
}
```

```ts
// src/state/store.ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import lockfile from 'proper-lockfile'
import { StateFile, emptyState } from './schema.js'

function home(): string { return process.env.BK_HOME ?? homedir() }
export function stateDir(project: string): string { return join(home(), '.bookkeeper', project) }
function statePath(project: string): string { return join(stateDir(project), 'state.json') }
function lockPath(project: string): string { return join(stateDir(project), 'lock') }

function ensureDir(project: string) { mkdirSync(stateDir(project), { recursive: true }) }

export async function readState(project: string): Promise<StateFile> {
  const p = statePath(project)
  if (!existsSync(p)) return emptyState(project)
  return JSON.parse(readFileSync(p, 'utf8')) as StateFile
}

function atomicWrite(project: string, s: StateFile) {
  const p = statePath(project)
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2))
  renameSync(tmp, p)
}

export async function withState<T>(
  project: string, fn: (s: StateFile) => Promise<T> | T,
): Promise<T> {
  ensureDir(project)
  // 锁文件必须存在才能加锁
  const lp = lockPath(project)
  if (!existsSync(lp)) writeFileSync(lp, '')
  const release = await lockfile.lock(lp, { retries: { retries: 50, factor: 1.2, minTimeout: 20 } })
  try {
    const s = await readState(project)
    const result = await fn(s)
    atomicWrite(project, s)
    return result
  } finally {
    await release()
  }
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/state/store.test.ts` → PASS（含并发串行化用例）

- [ ] **Step 5: Commit**

```bash
git add src/state tests/state
git commit -m "feat(state): state.json 项目级锁 + 原子写 + 并发串行化"
```

---

## Task 5: ResourceProvider 接口 + 选号逻辑

**Files:**
- Create: `src/providers/types.ts`, `src/core/numbering.ts`
- Test: `tests/core/numbering.test.ts`

**Interfaces:**
- Consumes: `Ctx`、`ResourceNames`、`SetRecord`、`StateFile`。
- Produces:
  - `interface ResourceProvider { kind: string; plan(n, ctx): Partial<ResourceNames>; probe(n, ctx): Promise<boolean>; provision(n, ctx): Promise<void>; destroy(n, ctx): Promise<void>; envVars(n, ctx): Record<string,string> }`
  - `pickNumber(state: StateFile): { n: number; reuse: boolean }` —— 优先复用最小 `free` set，否则取最小未占用正整数（从 1 起，填补空洞）。

- [ ] **Step 1: 写 providers/types.ts**

```ts
// src/providers/types.ts
import type { Ctx, ResourceNames } from '../core/types.js'
export interface ResourceProvider {
  kind: string
  plan(n: number, ctx: Ctx): Partial<ResourceNames>
  probe(n: number, ctx: Ctx): Promise<boolean>     // true=可用, false=撞了(跳号)
  provision(n: number, ctx: Ctx): Promise<void>
  destroy(n: number, ctx: Ctx): Promise<void>
  envVars(n: number, ctx: Ctx): Record<string, string>
}
```

- [ ] **Step 2: 写 numbering.test.ts**

```ts
// tests/core/numbering.test.ts
import { describe, it, expect } from 'vitest'
import { pickNumber } from '../../src/core/numbering.js'
import type { StateFile } from '../../src/state/schema.js'

const mk = (sets: Record<string, 'allocated' | 'free'>): StateFile => ({
  project_name: 'foo', config_fingerprint: '',
  sets: Object.fromEntries(Object.entries(sets).map(([n, st]) =>
    [n, { status: st, owner: null, resources: {}, created_at: 'x' }])),
})

describe('pickNumber', () => {
  it('空状态返回 1、非复用', () => {
    expect(pickNumber(mk({}))).toEqual({ n: 1, reuse: false })
  })
  it('有 free set 时复用最小 free', () => {
    expect(pickNumber(mk({ '1': 'allocated', '3': 'free', '4': 'free' }))).toEqual({ n: 3, reuse: true })
  })
  it('无 free 时取最小空洞', () => {
    expect(pickNumber(mk({ '1': 'allocated', '2': 'allocated' }))).toEqual({ n: 3, reuse: false })
  })
  it('填补销毁后的空洞', () => {
    expect(pickNumber(mk({ '1': 'allocated', '3': 'allocated' }))).toEqual({ n: 2, reuse: false })
  })
})
```

- [ ] **Step 3: 运行验证失败 → 写 numbering.ts → 验证通过**

Run: `npx vitest run tests/core/numbering.test.ts` → FAIL

```ts
// src/core/numbering.ts
import type { StateFile } from '../state/schema.js'
export function pickNumber(state: StateFile): { n: number; reuse: boolean } {
  const frees = Object.entries(state.sets)
    .filter(([, r]) => r.status === 'free')
    .map(([n]) => Number(n))
    .sort((a, b) => a - b)
  if (frees.length) return { n: frees[0], reuse: true }
  const used = new Set(Object.keys(state.sets).map(Number))
  let n = 1
  while (used.has(n)) n++
  return { n, reuse: false }
}
```

Run: `npx vitest run tests/core/numbering.test.ts` → PASS

- [ ] **Step 4: typecheck**

Run: `npm run typecheck` → 无错误

- [ ] **Step 5: Commit**

```bash
git add src/providers/types.ts src/core/numbering.ts tests/core/numbering.test.ts
git commit -m "feat(core): ResourceProvider 接口 + 选号（复用 free/填空洞）"
```

---

## Task 6: port provider

**Files:**
- Create: `src/providers/port.ts`
- Test: `tests/providers/port.test.ts`

**Interfaces:**
- Consumes: `ResourceProvider`、`Ctx`、`ServiceConfig`。
- Produces: `createPortProvider(): ResourceProvider`。`plan` 产出 `ports[svc]=port_base+n`；`probe` 对每个端口尝试 bind，任一被占返回 false；`provision/destroy` no-op；`envVars` 为空（端口走启动命令，不进 .env）。

- [ ] **Step 1: 写 port.test.ts**

```ts
// tests/providers/port.test.ts
import { describe, it, expect } from 'vitest'
import { createServer } from 'node:net'
import { createPortProvider } from '../../src/providers/port.js'
import type { Ctx } from '../../src/core/types.js'

const ctx = (): Ctx => ({
  projectRoot: '/x',
  config: {
    project_name: 'foo',
    services: [{ name: 'backend', type: 'django', port_base: 10000 }],
    infra: {},
  },
})

describe('port provider', () => {
  it('plan 产出 port_base + n', () => {
    expect(createPortProvider().plan(2, ctx()).ports).toEqual({ backend: 10002 })
  })
  it('端口空闲 probe 为 true', async () => {
    expect(await createPortProvider().probe(2, ctx())).toBe(true)
  })
  it('端口被占 probe 为 false', async () => {
    const srv = createServer().listen(10002)
    await new Promise(r => srv.once('listening', r))
    try { expect(await createPortProvider().probe(2, ctx())).toBe(false) }
    finally { srv.close() }
  })
})
```

- [ ] **Step 2: 运行验证失败 → 写 port.ts**

Run: `npx vitest run tests/providers/port.test.ts` → FAIL

```ts
// src/providers/port.ts
import { createServer } from 'node:net'
import type { ResourceProvider } from './types.js'
import type { Ctx } from '../core/types.js'

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

export function createPortProvider(): ResourceProvider {
  const ports = (n: number, ctx: Ctx) =>
    Object.fromEntries(ctx.config.services.map(s => [s.name, s.port_base + n]))
  return {
    kind: 'port',
    plan: (n, ctx) => ({ ports: ports(n, ctx) }),
    probe: async (n, ctx) => {
      for (const p of Object.values(ports(n, ctx))) if (!(await portFree(p))) return false
      return true
    },
    provision: async () => {},
    destroy: async () => {},
    envVars: () => ({}),
  }
}
```

- [ ] **Step 3: 验证通过**

Run: `npx vitest run tests/providers/port.test.ts` → PASS

- [ ] **Step 4: Commit**

```bash
git add src/providers/port.ts tests/providers/port.test.ts
git commit -m "feat(providers): port provider（plan + bind 探活）"
```

---

## Task 7: postgres provider（集成测）

**Files:**
- Create: `src/providers/postgres.ts`
- Test: `tests/providers/postgres.integration.test.ts`
- Create: `tests/helpers/docker.ts`

**Interfaces:**
- Consumes: `ResourceProvider`、`Ctx`、`InfraConfig.postgres`、`BkError`。
- Produces: `createPostgresProvider(): ResourceProvider`。`plan.database=<project>_<n>`；`probe` 查 `pg_database` 是否已存在该库（存在→false 跳号；连不上→抛 `BkError(INFRA_UNREACHABLE, recoverable:false)`）；`provision` `CREATE DATABASE`；`destroy` 先断开连接再 `DROP DATABASE`；`envVars` 产出 `BK_DB_*`。

- [ ] **Step 1: 写 docker helper + 集成测试**

```ts
// tests/helpers/docker.ts
import { execaSync } from 'execa'
export function hasDocker(): boolean {
  try { execaSync('docker', ['info']); return true } catch { return false }
}
```

```ts
// tests/providers/postgres.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, StartedPostgreSqlContainer } from 'testcontainers'
import { Client } from 'pg'
import { createPostgresProvider } from '../../src/providers/postgres.js'
import { hasDocker } from '../helpers/docker.js'
import type { Ctx } from '../../src/core/types.js'

const d = describe.runIf(hasDocker())
let pg: StartedPostgreSqlContainer
let ctx: Ctx

d('postgres provider', () => {
  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start()
    ctx = {
      projectRoot: '/x',
      config: {
        project_name: 'foo', services: [],
        infra: { postgres: { host: pg.getHost(), port: pg.getPort(), username: pg.getUsername(), password: pg.getPassword() } },
      },
    }
  }, 120_000)
  afterAll(async () => { await pg?.stop() })

  it('provision 建库、probe 复测为 false、destroy 删库', async () => {
    const p = createPostgresProvider()
    expect(p.plan(2, ctx).database).toBe('foo_2')
    expect(await p.probe(2, ctx)).toBe(true)
    await p.provision(2, ctx)
    expect(await p.probe(2, ctx)).toBe(false)   // 已存在 → 跳号
    expect(p.envVars(2, ctx).BK_DB_NAME).toBe('foo_2')
    await p.destroy(2, ctx)
    expect(await p.probe(2, ctx)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行验证失败（有 Docker）/跳过（无 Docker）**

Run: `npx vitest run tests/providers/postgres.integration.test.ts`
Expected: 有 Docker → FAIL（provider 未实现）；无 Docker → SKIPPED。

- [ ] **Step 3: 写 postgres.ts**

```ts
// src/providers/postgres.ts
import { Client } from 'pg'
import type { ResourceProvider } from './types.js'
import type { Ctx } from '../core/types.js'
import { BkError, Codes } from '../core/errors.js'

function dbName(n: number, ctx: Ctx) { return `${ctx.config.project_name}_${n}` }
function cfg(ctx: Ctx) {
  const pg = ctx.config.infra.postgres
  if (!pg) throw new BkError(Codes.CONFIG_INVALID, 'infra.postgres 未配置')
  return pg
}
async function withClient<T>(ctx: Ctx, fn: (c: Client) => Promise<T>): Promise<T> {
  const pg = cfg(ctx)
  const c = new Client({ host: pg.host, port: pg.port, user: pg.username, password: pg.password, database: 'postgres' })
  try { await c.connect() }
  catch (e: any) {
    throw new BkError(Codes.INFRA_UNREACHABLE, `无法连接 Postgres (${pg.host}:${pg.port})：${e.message}`,
      { recoverable: false, remediation: '你的本地开发数据库起了吗？' })
  }
  try { return await fn(c) } finally { await c.end() }
}

export function createPostgresProvider(): ResourceProvider {
  return {
    kind: 'postgres',
    plan: (n, ctx) => ({ database: dbName(n, ctx) }),
    probe: (n, ctx) => withClient(ctx, async (c) => {
      const r = await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName(n, ctx)])
      return r.rowCount === 0
    }),
    provision: (n, ctx) => withClient(ctx, async (c) => {
      await c.query(`CREATE DATABASE "${dbName(n, ctx)}"`)
    }),
    destroy: (n, ctx) => withClient(ctx, async (c) => {
      const name = dbName(n, ctx)
      await c.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [name])
      await c.query(`DROP DATABASE IF EXISTS "${name}"`)
    }),
    envVars: (n, ctx) => {
      const pg = cfg(ctx)
      return {
        BK_DB_HOST: pg.host, BK_DB_PORT: String(pg.port),
        BK_DB_USER: pg.username, BK_DB_PASSWORD: pg.password, BK_DB_NAME: dbName(n, ctx),
      }
    },
  }
}
```

- [ ] **Step 4: 验证通过（有 Docker）+ typecheck**

Run: `npx vitest run tests/providers/postgres.integration.test.ts` → PASS（有 Docker）
Run: `npm run typecheck` → 无错

- [ ] **Step 5: Commit**

```bash
git add src/providers/postgres.ts tests/providers/postgres.integration.test.ts tests/helpers/docker.ts
git commit -m "feat(providers): postgres provider（建库/探活/删库 + 连接错分类）"
```

---

## Task 8: redis provider（双模式）

**Files:**
- Create: `src/providers/redis.ts`
- Test: `tests/providers/redis.test.ts`（key_prefix 纯单测）, `tests/providers/redis.integration.test.ts`（db_number 集成）

**Interfaces:**
- Consumes: `ResourceProvider`、`InfraConfig.redis`、`BkError`。
- Produces: `createRedisProvider(): ResourceProvider`。`key_prefix` 模式：`plan.redisPrefix=<project>_<n>_`，probe/provision/destroy no-op，`envVars` 产 `BK_REDIS_HOST/PORT/PREFIX`。`db_number` 模式：`plan.redisDb=n`，n>15 时 probe 抛 `BkError(REDIS_DB_EXHAUSTED, recoverable:false)`，`envVars` 额外产 `BK_REDIS_DB`。

- [ ] **Step 1: 写 key_prefix 单测**

```ts
// tests/providers/redis.test.ts
import { describe, it, expect } from 'vitest'
import { createRedisProvider } from '../../src/providers/redis.js'
import type { Ctx } from '../../src/core/types.js'

const ctx = (iso: 'key_prefix' | 'db_number'): Ctx => ({
  projectRoot: '/x',
  config: { project_name: 'foo', services: [],
    infra: { redis: { host: 'localhost', port: 6379, isolation: iso } } },
})

describe('redis provider key_prefix', () => {
  it('plan 产前缀、envVars 含 BK_REDIS_PREFIX', () => {
    const p = createRedisProvider()
    expect(p.plan(2, ctx('key_prefix')).redisPrefix).toBe('foo_2_')
    expect(p.envVars(2, ctx('key_prefix')).BK_REDIS_PREFIX).toBe('foo_2_')
  })
  it('key_prefix 下 probe 恒 true（无副作用）', async () => {
    expect(await createRedisProvider().probe(99, ctx('key_prefix'))).toBe(true)
  })
})

describe('redis provider db_number', () => {
  it('n>15 时 probe 抛 REDIS_DB_EXHAUSTED', async () => {
    await expect(createRedisProvider().probe(16, ctx('db_number'))).rejects.toThrow(/REDIS_DB_EXHAUSTED|0-15/)
  })
  it('plan 产 redisDb、envVars 含 BK_REDIS_DB', () => {
    const p = createRedisProvider()
    expect(p.plan(3, ctx('db_number')).redisDb).toBe(3)
    expect(p.envVars(3, ctx('db_number')).BK_REDIS_DB).toBe('3')
  })
})
```

- [ ] **Step 2: 运行验证失败 → 写 redis.ts**

Run: `npx vitest run tests/providers/redis.test.ts` → FAIL

```ts
// src/providers/redis.ts
import type { ResourceProvider } from './types.js'
import type { Ctx } from '../core/types.js'
import { BkError, Codes } from '../core/errors.js'

function cfg(ctx: Ctx) {
  const r = ctx.config.infra.redis
  if (!r) throw new BkError(Codes.CONFIG_INVALID, 'infra.redis 未配置')
  return r
}
function prefix(n: number, ctx: Ctx) { return `${ctx.config.project_name}_${n}_` }

export function createRedisProvider(): ResourceProvider {
  return {
    kind: 'redis',
    plan: (n, ctx) => cfg(ctx).isolation === 'db_number'
      ? { redisDb: n } : { redisPrefix: prefix(n, ctx) },
    probe: async (n, ctx) => {
      if (cfg(ctx).isolation === 'db_number' && n > 15)
        throw new BkError(Codes.REDIS_DB_EXHAUSTED,
          `redis db_number 模式仅支持 0-15，编号 ${n} 越界`,
          { recoverable: false, remediation: '改用 isolation: key_prefix 以突破 15 套上限' })
      return true   // 两模式均无需预建
    },
    provision: async () => {},
    destroy: async () => {},   // key_prefix 可选 SCAN+DEL，首批不做
    envVars: (n, ctx) => {
      const r = cfg(ctx)
      const base = { BK_REDIS_HOST: r.host, BK_REDIS_PORT: String(r.port) }
      return r.isolation === 'db_number'
        ? { ...base, BK_REDIS_DB: String(n) }
        : { ...base, BK_REDIS_PREFIX: prefix(n, ctx) }
    },
  }
}
```

- [ ] **Step 3: 验证 key_prefix 单测通过**

Run: `npx vitest run tests/providers/redis.test.ts` → PASS

- [ ] **Step 4: 写 db_number 集成冒烟测（可选连真 redis 验证连通）**

```ts
// tests/providers/redis.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import Redis from 'ioredis'
import { hasDocker } from '../helpers/docker.js'

const d = describe.runIf(hasDocker())
let c: StartedTestContainer
d('redis db_number 连通冒烟', () => {
  beforeAll(async () => { c = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start() }, 120_000)
  afterAll(async () => { await c?.stop() })
  it('能 select db 3 并读写', async () => {
    const r = new Redis({ host: c.getHost(), port: c.getMappedPort(6379), db: 3 })
    await r.set('k', 'v'); expect(await r.get('k')).toBe('v'); await r.quit()
  })
})
```

Run: `npx vitest run tests/providers/redis.integration.test.ts` → PASS（有 Docker）

- [ ] **Step 5: Commit**

```bash
git add src/providers/redis.ts tests/providers/redis.test.ts tests/providers/redis.integration.test.ts
git commit -m "feat(providers): redis provider（key_prefix/db_number 双模式 + 15 上限护栏）"
```

---

## Task 9: minio provider（集成测）

**Files:**
- Create: `src/providers/minio.ts`
- Test: `tests/providers/minio.integration.test.ts`

**Interfaces:**
- Consumes: `ResourceProvider`、`InfraConfig.minio`、`BkError`。
- Produces: `createMinioProvider(): ResourceProvider`。`plan.bucket=<project>-<n>`（连字符）；`probe` `bucketExists`（存在→false）；`provision` `makeBucket`；`destroy` 清空对象再删桶；`envVars` 产 `BK_MINIO_*`。

- [ ] **Step 1: 写集成测试**

```ts
// tests/providers/minio.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import { createMinioProvider } from '../../src/providers/minio.js'
import { hasDocker } from '../helpers/docker.js'
import type { Ctx } from '../../src/core/types.js'

const d = describe.runIf(hasDocker())
let c: StartedTestContainer
let ctx: Ctx
d('minio provider', () => {
  beforeAll(async () => {
    c = await new GenericContainer('minio/minio:latest')
      .withCommand(['server', '/data']).withExposedPorts(9000)
      .withEnvironment({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' })
      .start()
    ctx = { projectRoot: '/x', config: { project_name: 'foo', services: [],
      infra: { minio: { endpoint: `${c.getHost()}:${c.getMappedPort(9000)}`, access_key: 'minioadmin', secret_key: 'minioadmin' } } } }
  }, 120_000)
  afterAll(async () => { await c?.stop() })

  it('plan 用连字符、provision/probe/destroy 闭环', async () => {
    const p = createMinioProvider()
    expect(p.plan(2, ctx).bucket).toBe('foo-2')
    expect(await p.probe(2, ctx)).toBe(true)
    await p.provision(2, ctx)
    expect(await p.probe(2, ctx)).toBe(false)
    await p.destroy(2, ctx)
    expect(await p.probe(2, ctx)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行验证失败 → 写 minio.ts**

Run: `npx vitest run tests/providers/minio.integration.test.ts` → FAIL（有 Docker）

```ts
// src/providers/minio.ts
import { Client } from 'minio'
import type { ResourceProvider } from './types.js'
import type { Ctx } from '../core/types.js'
import { BkError, Codes } from '../core/errors.js'

function bucket(n: number, ctx: Ctx) { return `${ctx.config.project_name}-${n}` }
function client(ctx: Ctx): Client {
  const m = ctx.config.infra.minio
  if (!m) throw new BkError(Codes.CONFIG_INVALID, 'infra.minio 未配置')
  const [host, port] = m.endpoint.split(':')
  return new Client({ endPoint: host, port: Number(port) || 9000, useSSL: false,
    accessKey: m.access_key, secretKey: m.secret_key })
}
function wrap(ctx: Ctx, e: any): never {
  throw new BkError(Codes.INFRA_UNREACHABLE, `无法连接 MinIO：${e.message}`,
    { recoverable: false, remediation: '检查 infra.minio.endpoint 与本地 MinIO 是否运行' })
}

export function createMinioProvider(): ResourceProvider {
  return {
    kind: 'minio',
    plan: (n, ctx) => ({ bucket: bucket(n, ctx) }),
    probe: async (n, ctx) => {
      try { return !(await client(ctx).bucketExists(bucket(n, ctx))) }
      catch (e) { wrap(ctx, e) }
    },
    provision: async (n, ctx) => {
      try { await client(ctx).makeBucket(bucket(n, ctx)) } catch (e) { wrap(ctx, e) }
    },
    destroy: async (n, ctx) => {
      const c = client(ctx); const b = bucket(n, ctx)
      const stream = c.listObjectsV2(b, '', true)
      const names: string[] = await new Promise((res, rej) => {
        const acc: string[] = []
        stream.on('data', (o) => o.name && acc.push(o.name))
        stream.on('end', () => res(acc)); stream.on('error', rej)
      })
      if (names.length) await c.removeObjects(b, names)
      await c.removeBucket(b)
    },
    envVars: (n, ctx) => {
      const m = ctx.config.infra.minio!
      return { BK_MINIO_ENDPOINT: m.endpoint, BK_MINIO_ACCESS_KEY: m.access_key,
        BK_MINIO_SECRET_KEY: m.secret_key, BK_MINIO_BUCKET: bucket(n, ctx) }
    },
  }
}
```

- [ ] **Step 3: 验证通过 + typecheck**

Run: `npx vitest run tests/providers/minio.integration.test.ts` → PASS（有 Docker）
Run: `npm run typecheck` → 无错

- [ ] **Step 4: 写 provider registry**

```ts
// src/providers/registry.ts
import type { ResourceProvider } from './types.js'
import type { Ctx } from '../core/types.js'
import { createPortProvider } from './port.js'
import { createPostgresProvider } from './postgres.js'
import { createRedisProvider } from './redis.js'
import { createMinioProvider } from './minio.js'

export function activeProviders(ctx: Ctx): ResourceProvider[] {
  const list: ResourceProvider[] = [createPortProvider()]
  if (ctx.config.infra.postgres) list.push(createPostgresProvider())
  if (ctx.config.infra.redis) list.push(createRedisProvider())
  if (ctx.config.infra.minio) list.push(createMinioProvider())
  return list
}
```

- [ ] **Step 5: Commit**

```bash
git add src/providers/minio.ts src/providers/registry.ts tests/providers/minio.integration.test.ts
git commit -m "feat(providers): minio provider（连字符桶名 + 清空删桶）+ provider registry"
```

---

## Task 10: FrameworkAdapter（detect + 默认启动命令）

**Files:**
- Create: `src/frameworks/types.ts`, `src/frameworks/{django,fastapi,vite}.ts`, `src/frameworks/registry.ts`
- Test: `tests/frameworks/detect.test.ts`, `tests/frameworks/command.test.ts`
- Create: `tests/fixtures/{django-proj,fastapi-proj,vite-proj}/`（含特征文件）

**Interfaces:**
- Consumes: `ServiceConfig`。
- Produces:
  - `interface FrameworkAdapter { type: ServiceType; detect(dir: string): boolean; defaultStartCommand(svc: ServiceConfig, port: number): string }`
  - `adapterFor(type): FrameworkAdapter`；`detectType(dir): ServiceType | null`。

- [ ] **Step 1: 造 fixtures + 写 detect/command 测试**

创建特征文件：`tests/fixtures/django-proj/manage.py`（空文件即可）、`tests/fixtures/fastapi-proj/pyproject.toml`（内容含 `fastapi`）、`tests/fixtures/vite-proj/vite.config.ts`（空）。

```ts
// tests/frameworks/detect.test.ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { detectType } from '../../src/frameworks/registry.js'

const fx = (p: string) => join(__dirname, '..', 'fixtures', p)

describe('detectType', () => {
  it('manage.py → django', () => expect(detectType(fx('django-proj'))).toBe('django'))
  it('pyproject 含 fastapi → fastapi', () => expect(detectType(fx('fastapi-proj'))).toBe('fastapi'))
  it('vite.config → vite', () => expect(detectType(fx('vite-proj'))).toBe('vite'))
  it('无特征 → null', () => expect(detectType(fx('.'))).toBe(null))
})
```

```ts
// tests/frameworks/command.test.ts
import { describe, it, expect } from 'vitest'
import { adapterFor } from '../../src/frameworks/registry.js'

describe('defaultStartCommand', () => {
  it('django', () => expect(adapterFor('django').defaultStartCommand({ name: 'b', type: 'django', port_base: 10000 }, 10002))
    .toBe('uv run python manage.py runserver 0.0.0.0:10002'))
  it('fastapi 用 app 字段', () => expect(adapterFor('fastapi').defaultStartCommand({ name: 'b', type: 'fastapi', port_base: 10000, app: 'app.main:app' }, 10002))
    .toBe('uv run uvicorn app.main:app --port 10002'))
  it('vite', () => expect(adapterFor('vite').defaultStartCommand({ name: 'f', type: 'vite', port_base: 10100 }, 10102))
    .toBe('npm run dev -- --port 10102'))
})
```

- [ ] **Step 2: 运行验证失败 → 写 adapters + types + registry**

Run: `npx vitest run tests/frameworks` → FAIL

```ts
// src/frameworks/types.ts
import type { ServiceConfig, ServiceType } from '../core/types.js'
export interface FrameworkAdapter {
  type: ServiceType
  detect(dir: string): boolean
  defaultStartCommand(svc: ServiceConfig, port: number): string
}
```

```ts
// src/frameworks/django.ts
import { existsSync } from 'node:fs'; import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
export const django: FrameworkAdapter = {
  type: 'django',
  detect: (dir) => existsSync(join(dir, 'manage.py')),
  defaultStartCommand: (_svc, port) => `uv run python manage.py runserver 0.0.0.0:${port}`,
}
```

```ts
// src/frameworks/fastapi.ts
import { existsSync, readFileSync } from 'node:fs'; import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'
export const fastapi: FrameworkAdapter = {
  type: 'fastapi',
  detect: (dir) => {
    const p = join(dir, 'pyproject.toml')
    return existsSync(p) && /fastapi/i.test(readFileSync(p, 'utf8'))
  },
  defaultStartCommand: (svc, port) => {
    if (!svc.app) throw new BkError(Codes.CONFIG_INVALID,
      `fastapi service ${svc.name} 需在 config 设置 app（如 app.main:app）或 command`)
    return `uv run uvicorn ${svc.app} --port ${port}`
  },
}
```

```ts
// src/frameworks/vite.ts
import { existsSync } from 'node:fs'; import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
export const vite: FrameworkAdapter = {
  type: 'vite',
  detect: (dir) => ['vite.config.ts', 'vite.config.js'].some(f => existsSync(join(dir, f))),
  defaultStartCommand: (_svc, port) => `npm run dev -- --port ${port}`,
}
```

```ts
// src/frameworks/registry.ts
import type { ServiceType } from '../core/types.js'
import type { FrameworkAdapter } from './types.js'
import { django } from './django.js'; import { fastapi } from './fastapi.js'; import { vite } from './vite.js'
const ALL: FrameworkAdapter[] = [django, fastapi, vite]
export function adapterFor(type: ServiceType): FrameworkAdapter {
  const a = ALL.find(x => x.type === type)
  if (!a) throw new Error(`未知 service type: ${type}`)
  return a
}
export function detectType(dir: string): ServiceType | null {
  return ALL.find(a => a.detect(dir))?.type ?? null
}
```

- [ ] **Step 3: 验证通过 + typecheck**

Run: `npx vitest run tests/frameworks && npm run typecheck` → PASS / 无错

- [ ] **Step 4: Commit**

```bash
git add src/frameworks tests/frameworks tests/fixtures
git commit -m "feat(frameworks): django/fastapi/vite 侦测 + 默认启动命令"
```

---

## Task 11: inject —— .env 标记块 + .gitignore

**Files:**
- Create: `src/inject/env.ts`, `src/inject/gitignore.ts`
- Test: `tests/inject/env.test.ts`, `tests/inject/gitignore.test.ts`

**Interfaces:**
- Produces:
  - `writeEnvBlock(envPath: string, vars: Record<string,string>): void` —— 在 `.env` 中插入/替换 `# >>> bk managed >>>`…`# <<< bk managed <<<` 块；保留块外内容；文件不存在则新建仅含块的文件。
  - `removeEnvBlock(envPath: string): void` —— 删除标记块，保留其余。
  - `ensureGitignore(root: string, entries: string[]): void` —— 幂等追加条目（如 `.env`）。

- [ ] **Step 1: 写 env.test.ts**

```ts
// tests/inject/env.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { writeEnvBlock, removeEnvBlock } from '../../src/inject/env.js'

let dir: string, env: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bk-')); env = join(dir, '.env') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('writeEnvBlock', () => {
  it('文件不存在时新建仅含块', () => {
    writeEnvBlock(env, { BK_DB_NAME: 'foo_2' })
    const c = readFileSync(env, 'utf8')
    expect(c).toContain('# >>> bk managed >>>')
    expect(c).toContain('BK_DB_NAME=foo_2')
    expect(c).toContain('# <<< bk managed <<<')
  })
  it('保留块外用户内容、只替换块内', () => {
    writeFileSync(env, 'SECRET=keepme\n# >>> bk managed >>>\nBK_DB_NAME=old\n# <<< bk managed <<<\nTAIL=z\n')
    writeEnvBlock(env, { BK_DB_NAME: 'foo_3' })
    const c = readFileSync(env, 'utf8')
    expect(c).toContain('SECRET=keepme')
    expect(c).toContain('TAIL=z')
    expect(c).toContain('BK_DB_NAME=foo_3')
    expect(c).not.toContain('BK_DB_NAME=old')
  })
  it('removeEnvBlock 删块留其余', () => {
    writeEnvBlock(env, { BK_DB_NAME: 'foo_2' })
    writeFileSync(env, 'KEEP=1\n' + readFileSync(env, 'utf8'))
    removeEnvBlock(env)
    const c = readFileSync(env, 'utf8')
    expect(c).toContain('KEEP=1')
    expect(c).not.toContain('bk managed')
  })
})
```

- [ ] **Step 2: 运行验证失败 → 写 env.ts**

Run: `npx vitest run tests/inject/env.test.ts` → FAIL

```ts
// src/inject/env.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const BEGIN = '# >>> bk managed >>>'
const END = '# <<< bk managed <<<'

function renderBlock(vars: Record<string, string>): string {
  const body = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')
  return `${BEGIN}\n${body}\n${END}`
}
function stripBlock(content: string): string {
  const re = new RegExp(`\\n?${escape(BEGIN)}[\\s\\S]*?${escape(END)}\\n?`, 'g')
  return content.replace(re, '\n').replace(/^\n+/, '')
}
function escape(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

export function writeEnvBlock(envPath: string, vars: Record<string, string>): void {
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const without = stripBlock(existing)
  const sep = without && !without.endsWith('\n') ? '\n' : ''
  const head = without ? without + sep : ''
  writeFileSync(envPath, `${head}${renderBlock(vars)}\n`)
}
export function removeEnvBlock(envPath: string): void {
  if (!existsSync(envPath)) return
  writeFileSync(envPath, stripBlock(readFileSync(envPath, 'utf8')))
}
```

- [ ] **Step 3: 验证通过 → 写 gitignore.ts + 测试**

Run: `npx vitest run tests/inject/env.test.ts` → PASS

```ts
// tests/inject/gitignore.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { ensureGitignore } from '../../src/inject/gitignore.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bk-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ensureGitignore', () => {
  it('新建并追加；重复调用幂等', () => {
    ensureGitignore(dir, ['.env'])
    ensureGitignore(dir, ['.env'])
    const lines = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n').filter(Boolean)
    expect(lines.filter(l => l === '.env')).toHaveLength(1)
  })
  it('保留已有内容', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
    ensureGitignore(dir, ['.env'])
    const c = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(c).toContain('node_modules/'); expect(c).toContain('.env')
  })
})
```

```ts
// src/inject/gitignore.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export function ensureGitignore(root: string, entries: string[]): void {
  const p = join(root, '.gitignore')
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const have = new Set(existing.split('\n').map(l => l.trim()))
  const add = entries.filter(e => !have.has(e))
  if (!add.length) return
  const sep = existing && !existing.endsWith('\n') ? '\n' : ''
  writeFileSync(p, existing + sep + add.join('\n') + '\n')
}
```

- [ ] **Step 4: 验证全部 inject 测试通过**

Run: `npx vitest run tests/inject` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/inject tests/inject
git commit -m "feat(inject): .env 标记块读-合并-写 + .gitignore 幂等维护"
```

---

## Task 12: git worktree 封装

**Files:**
- Create: `src/git/worktree.ts`
- Test: `tests/git/worktree.test.ts`

**Interfaces:**
- Consumes: execa。
- Produces:
  - `sanitizeBranch(branch: string): string` —— `/`→`-`。
  - `worktreeDirName(project: string, branch: string): string` —— `<project>.<sanitized>`。
  - `async addWorktree(repoRoot: string, branch: string, dir: string): Promise<void>` —— `git -C repoRoot worktree add -b <branch> <dir>`（分支已存在则不带 `-b`）。
  - `async removeWorktree(repoRoot: string, dir: string): Promise<void>`。

- [ ] **Step 1: 写测试（纯函数 + 真 git 临时仓）**

```ts
// tests/git/worktree.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { sanitizeBranch, worktreeDirName, addWorktree, removeWorktree } from '../../src/git/worktree.js'

describe('naming', () => {
  it('sanitizeBranch 把 / 换成 -', () => expect(sanitizeBranch('feature/login')).toBe('feature-login'))
  it('worktreeDirName 组合 project.branch', () =>
    expect(worktreeDirName('foo', 'feature/login')).toBe('foo.feature-login'))
})

describe('add/remove worktree（真 git）', () => {
  let repo: string
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'bkrepo-'))
    await execa('git', ['-C', repo, 'init', '-b', 'main'])
    await execa('git', ['-C', repo, 'config', 'user.email', 't@t.io'])
    await execa('git', ['-C', repo, 'config', 'user.name', 't'])
    writeFileSync(join(repo, 'f.txt'), 'x')
    await execa('git', ['-C', repo, 'add', '.'])
    await execa('git', ['-C', repo, 'commit', '-m', 'init'])
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('创建并删除 worktree', async () => {
    const dir = join(repo, '..', worktreeDirName('foo', 'feature/x'))
    await addWorktree(repo, 'feature/x', dir)
    expect(existsSync(dir)).toBe(true)
    await removeWorktree(repo, dir)
    expect(existsSync(dir)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行验证失败 → 写 worktree.ts**

Run: `npx vitest run tests/git/worktree.test.ts` → FAIL

```ts
// src/git/worktree.ts
import { execa } from 'execa'
export function sanitizeBranch(branch: string): string { return branch.replace(/\//g, '-') }
export function worktreeDirName(project: string, branch: string): string {
  return `${project}.${sanitizeBranch(branch)}`
}
async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try { await execa('git', ['-C', repoRoot, 'rev-parse', '--verify', branch]); return true }
  catch { return false }
}
export async function addWorktree(repoRoot: string, branch: string, dir: string): Promise<void> {
  const args = ['-C', repoRoot, 'worktree', 'add']
  if (await branchExists(repoRoot, branch)) args.push(dir, branch)
  else args.push('-b', branch, dir)
  await execa('git', args)
}
export async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
  await execa('git', ['-C', repoRoot, 'worktree', 'remove', '--force', dir])
}
```

- [ ] **Step 3: 验证通过 + Commit**

Run: `npx vitest run tests/git/worktree.test.ts` → PASS

```bash
git add src/git tests/git
git commit -m "feat(git): worktree add/remove 封装 + 分支名净化/目录命名"
```

---

## Task 13: allocator（选号 → 探活跳号 → provision → 回滚）

**Files:**
- Create: `src/core/allocator.ts`
- Test: `tests/core/allocator.test.ts`
- Create: `tests/helpers/fakeProvider.ts`

**Interfaces:**
- Consumes: `ResourceProvider`、`pickNumber`、`BkError`、`Ctx`、`SetRecord`、`StateFile`。
- Produces:
  - `async resolveSet(providers: ResourceProvider[], ctx: Ctx, state: StateFile, maxAttempts: number): Promise<{ n: number; reuse: boolean }>` —— 选号；对候选 N 跑全部 provider `probe`，任一 false → 下一个 N；超 maxAttempts 抛 `BkError(PROBE_EXHAUSTED)`。
  - `async provisionSet(providers: ResourceProvider[], ctx: Ctx, n: number): Promise<void>` —— 顺序 provision，致命错时倒序 destroy 已成功者后重新抛出。
  - `buildSetRecord(providers, ctx, n, owner): SetRecord` —— 汇总 plan() 为固化 resources 快照。
  - `collectEnv(providers, ctx, n): Record<string,string>` —— 合并所有 envVars。

- [ ] **Step 1: 写 fakeProvider helper + allocator 测试**

```ts
// tests/helpers/fakeProvider.ts
import type { ResourceProvider } from '../../src/providers/types.js'
export function fakeProvider(opts: Partial<ResourceProvider> & { kind: string }): ResourceProvider {
  return {
    plan: () => ({}), probe: async () => true, provision: async () => {},
    destroy: async () => {}, envVars: () => ({}), ...opts,
  }
}
```

```ts
// tests/core/allocator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { resolveSet, provisionSet } from '../../src/core/allocator.js'
import { fakeProvider } from '../helpers/fakeProvider.js'
import type { Ctx } from '../../src/core/types.js'
import type { StateFile } from '../../src/state/schema.js'

const ctx = {} as Ctx
const emptyState: StateFile = { project_name: 'foo', config_fingerprint: '', sets: {} }

describe('resolveSet', () => {
  it('全部 probe 通过 → 取号 1', async () => {
    const p = [fakeProvider({ kind: 'a' })]
    expect(await resolveSet(p, ctx, emptyState, 20)).toEqual({ n: 1, reuse: false })
  })
  it('号 1 撞了 → 跳到号 2', async () => {
    const probe = vi.fn().mockImplementation(async (n: number) => n !== 1)
    const p = [fakeProvider({ kind: 'a', probe })]
    expect((await resolveSet(p, ctx, emptyState, 20)).n).toBe(2)
  })
  it('连撞超过上限 → PROBE_EXHAUSTED', async () => {
    const p = [fakeProvider({ kind: 'a', probe: async () => false })]
    await expect(resolveSet(p, ctx, emptyState, 3)).rejects.toThrow(/PROBE_EXHAUSTED/)
  })
})

describe('provisionSet 回滚', () => {
  it('后一个 provision 致命错 → 倒序 destroy 已成功者', async () => {
    const destroyA = vi.fn(async () => {})
    const a = fakeProvider({ kind: 'a', destroy: destroyA })
    const b = fakeProvider({ kind: 'b', provision: async () => { throw new Error('boom') } })
    await expect(provisionSet([a, b], ctx, 1)).rejects.toThrow('boom')
    expect(destroyA).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 运行验证失败 → 写 allocator.ts**

Run: `npx vitest run tests/core/allocator.test.ts` → FAIL

```ts
// src/core/allocator.ts
import type { ResourceProvider } from '../providers/types.js'
import type { Ctx, ResourceNames, SetRecord } from '../core/types.js'
import type { StateFile } from '../state/schema.js'
import { pickNumber } from './numbering.js'
import { BkError, Codes } from './errors.js'

export async function resolveSet(
  providers: ResourceProvider[], ctx: Ctx, state: StateFile, maxAttempts: number,
): Promise<{ n: number; reuse: boolean }> {
  let { n, reuse } = pickNumber(state)
  // free set 复用：信任快照、不再探活
  if (reuse) return { n, reuse }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let ok = true
    for (const p of providers) { if (!(await p.probe(n, ctx))) { ok = false; break } }
    if (ok) return { n, reuse: false }
    // 该号被占，标记为"占用"再选下一个空洞
    state.sets[String(n)] = { status: 'allocated', owner: null, resources: {}, created_at: '' }
    n = pickNumber(state).n
  }
  throw new BkError(Codes.PROBE_EXHAUSTED,
    `连试 ${maxAttempts} 个编号都被占用，放弃。`,
    { remediation: '清理占用端口/库的野进程，或提高 allocation.max_probe_attempts' })
}

export async function provisionSet(providers: ResourceProvider[], ctx: Ctx, n: number): Promise<void> {
  const done: ResourceProvider[] = []
  try {
    for (const p of providers) { await p.provision(n, ctx); done.push(p) }
  } catch (e) {
    for (const p of done.reverse()) { try { await p.destroy(n, ctx) } catch { /* 回滚尽力 */ } }
    throw e
  }
}

export function collectEnv(providers: ResourceProvider[], ctx: Ctx, n: number): Record<string, string> {
  return Object.assign({}, ...providers.map(p => p.envVars(n, ctx)))
}

export function buildSetRecord(
  providers: ResourceProvider[], ctx: Ctx, n: number,
  owner: SetRecord['owner'],
): SetRecord {
  const names: Partial<ResourceNames> = Object.assign({}, ...providers.map(p => p.plan(n, ctx)))
  const resources: SetRecord['resources'] = {}
  for (const [svc, port] of Object.entries(names.ports ?? {})) resources[svc] = { port }
  if (names.database) resources.postgres = { database: names.database }
  if (names.redisPrefix || names.redisDb !== undefined)
    resources.redis = { prefix: names.redisPrefix, db: names.redisDb }
  if (names.bucket) resources.minio = { bucket: names.bucket }
  return { status: owner ? 'allocated' : 'free', owner, resources, created_at: new Date().toISOString() }
}
```

注：`resolveSet` 中对"探活撞了"的号临时写入 state 副本只为驱动 `pickNumber` 跳号，最终不持久化（调用方在锁内用真正结果覆盖）。

- [ ] **Step 3: 验证通过 + typecheck**

Run: `npx vitest run tests/core/allocator.test.ts && npm run typecheck` → PASS / 无错

- [ ] **Step 4: Commit**

```bash
git add src/core/allocator.ts tests/core/allocator.test.ts tests/helpers/fakeProvider.ts
git commit -m "feat(core): allocator 选号/探活跳号/provision/回滚 + 固化快照构建"
```

---

## Task 14: deallocator + destroyer（含护栏）

**Files:**
- Create: `src/core/deallocator.ts`, `src/core/destroyer.ts`
- Test: `tests/core/deallocator.test.ts`, `tests/core/destroyer.test.ts`

**Interfaces:**
- Consumes: `ResourceProvider`、`StateFile`、`SetRecord`、`BkError`。
- Produces:
  - `findSetByWorktree(state, worktreeDir): string | null` —— 按 owner.worktree 反查 set 号。
  - `deallocateInState(state, n): void` —— set → `free`，owner=null（不删资源）。
  - `async destroySet(providers, ctx, state, n, opts): Promise<void>` —— 护栏：`status==='allocated'` 且非 `opts.force` → 抛 `BkError(SET_IN_USE)`；否则遍历 provider destroy、删 set 条目。

- [ ] **Step 1: 写 deallocator 测试 + 实现**

```ts
// tests/core/deallocator.test.ts
import { describe, it, expect } from 'vitest'
import { findSetByWorktree, deallocateInState } from '../../src/core/deallocator.js'
import type { StateFile } from '../../src/state/schema.js'

const state = (): StateFile => ({ project_name: 'foo', config_fingerprint: '', sets: {
  '2': { status: 'allocated', owner: { worktree: '/wt/foo.x', branch: 'x' }, resources: {}, created_at: 'x' },
}})

describe('deallocator', () => {
  it('按 worktree 反查 set', () => expect(findSetByWorktree(state(), '/wt/foo.x')).toBe('2'))
  it('找不到返回 null', () => expect(findSetByWorktree(state(), '/nope')).toBe(null))
  it('deallocateInState → free + owner null（资源留存）', () => {
    const s = state(); deallocateInState(s, '2')
    expect(s.sets['2'].status).toBe('free'); expect(s.sets['2'].owner).toBe(null)
  })
})
```

```ts
// src/core/deallocator.ts
import type { StateFile } from '../state/schema.js'
export function findSetByWorktree(state: StateFile, worktreeDir: string): string | null {
  for (const [n, r] of Object.entries(state.sets))
    if (r.owner?.worktree === worktreeDir) return n
  return null
}
export function deallocateInState(state: StateFile, n: string): void {
  const r = state.sets[n]; if (!r) return
  r.status = 'free'; r.owner = null
}
```

- [ ] **Step 2: 验证通过 → 写 destroyer 测试 + 实现**

Run: `npx vitest run tests/core/deallocator.test.ts` → PASS

```ts
// tests/core/destroyer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { destroySet } from '../../src/core/destroyer.js'
import { fakeProvider } from '../helpers/fakeProvider.js'
import type { StateFile } from '../../src/state/schema.js'
import type { Ctx } from '../../src/core/types.js'

const ctx = {} as Ctx
const mk = (status: 'allocated' | 'free'): StateFile => ({ project_name: 'foo', config_fingerprint: '', sets: {
  '2': { status, owner: status === 'allocated' ? { worktree: '/w', branch: 'x' } : null, resources: {}, created_at: 'x' },
}})

describe('destroySet', () => {
  it('占用中且非 force → SET_IN_USE，不删', async () => {
    const s = mk('allocated')
    await expect(destroySet([fakeProvider({ kind: 'a' })], ctx, s, 2, { force: false }))
      .rejects.toThrow(/SET_IN_USE/)
    expect(s.sets['2']).toBeDefined()
  })
  it('force 时即便占用也销毁、调 provider.destroy、删条目', async () => {
    const destroy = vi.fn(async () => {})
    const s = mk('allocated')
    await destroySet([fakeProvider({ kind: 'a', destroy })], ctx, s, 2, { force: true })
    expect(destroy).toHaveBeenCalledWith(2, ctx)
    expect(s.sets['2']).toBeUndefined()
  })
  it('free 资源直接销毁', async () => {
    const s = mk('free')
    await destroySet([fakeProvider({ kind: 'a' })], ctx, s, 2, { force: false })
    expect(s.sets['2']).toBeUndefined()
  })
})
```

```ts
// src/core/destroyer.ts
import type { ResourceProvider } from '../providers/types.js'
import type { Ctx } from '../core/types.js'
import type { StateFile } from '../state/schema.js'
import { BkError, Codes } from './errors.js'

export async function destroySet(
  providers: ResourceProvider[], ctx: Ctx, state: StateFile, n: number,
  opts: { force: boolean },
): Promise<void> {
  const key = String(n)
  const r = state.sets[key]
  if (!r) throw new BkError(Codes.CONFIG_INVALID, `编号 ${n} 不存在`)
  if (r.status === 'allocated' && !opts.force)
    throw new BkError(Codes.SET_IN_USE,
      `编号 ${n} 正被 ${r.owner?.worktree} 使用`,
      { remediation: '先 deallocate / bk worktree delete，或加 --force' })
  for (const p of providers) { try { await p.destroy(n, ctx) } catch { /* 尽力销毁 */ } }
  delete state.sets[key]
}
```

- [ ] **Step 3: 验证通过 + typecheck**

Run: `npx vitest run tests/core/destroyer.test.ts && npm run typecheck` → PASS / 无错

- [ ] **Step 4: Commit**

```bash
git add src/core/deallocator.ts src/core/destroyer.ts tests/core/deallocator.test.ts tests/core/destroyer.test.ts
git commit -m "feat(core): deallocator（退回池子）+ destroyer（占用护栏 + 销毁）"
```

---

## Task 15: launch —— start 策略（tmux/iTerm/print）

**Files:**
- Create: `src/launch/index.ts`, `src/launch/print.ts`, `src/launch/tmux.ts`, `src/launch/iterm.ts`
- Test: `tests/launch/select.test.ts`, `tests/launch/print.test.ts`

**Interfaces:**
- Consumes: execa、`ServiceConfig`、`adapterFor`。
- Produces:
  - `interface LaunchSpec { name: string; command: string; cwd: string }`
  - `buildLaunchSpecs(ctx, setRecord, worktreeDir, only?): LaunchSpec[]` —— 据 config 各 service 算最终命令（config.command 优先，否则 adapter 默认；填入该 set 的端口）。
  - `selectStrategy(env, force?): 'tmux' | 'iterm' | 'print'` —— `force` 优先；否则 `TMUX` 存在→tmux；`darwin` 且 `TERM_PROGRAM==='iTerm.app'`→iterm；否则 print。
  - `async runLaunch(specs, strategy): Promise<void>`。

- [ ] **Step 1: 写策略选择 + print 渲染测试**

```ts
// tests/launch/select.test.ts
import { describe, it, expect } from 'vitest'
import { selectStrategy } from '../../src/launch/index.js'

describe('selectStrategy', () => {
  it('force 优先', () => expect(selectStrategy({}, 'print')).toBe('print'))
  it('TMUX 环境 → tmux', () => expect(selectStrategy({ TMUX: '/tmp/x' })).toBe('tmux'))
  it('macOS iTerm → iterm', () =>
    expect(selectStrategy({ __platform: 'darwin', TERM_PROGRAM: 'iTerm.app' })).toBe('iterm'))
  it('其他 → print', () => expect(selectStrategy({ __platform: 'linux' })).toBe('print'))
})
```

```ts
// tests/launch/print.test.ts
import { describe, it, expect } from 'vitest'
import { renderPrint } from '../../src/launch/print.js'

describe('renderPrint', () => {
  it('每个 service 一行命令 + cwd', () => {
    const out = renderPrint([
      { name: 'backend', command: 'uv run ... :10002', cwd: '/wt' },
      { name: 'frontend', command: 'npm run dev -- --port 10102', cwd: '/wt' },
    ])
    expect(out).toContain('backend')
    expect(out).toContain('uv run ... :10002')
    expect(out).toContain('frontend')
  })
})
```

- [ ] **Step 2: 运行验证失败 → 写 index.ts + print.ts**

Run: `npx vitest run tests/launch` → FAIL

```ts
// src/launch/print.ts
import type { LaunchSpec } from './index.js'
export function renderPrint(specs: LaunchSpec[]): string {
  return specs.map(s => `# ${s.name}  (cwd: ${s.cwd})\n${s.command}`).join('\n\n')
}
```

```ts
// src/launch/index.ts
import { execa } from 'execa'
import type { Ctx, SetRecord } from '../core/types.js'
import { adapterFor } from '../frameworks/registry.js'
import { renderPrint } from './print.js'
import { runTmux } from './tmux.js'
import { runIterm } from './iterm.js'

export interface LaunchSpec { name: string; command: string; cwd: string }
export type Strategy = 'tmux' | 'iterm' | 'print'

export function buildLaunchSpecs(ctx: Ctx, set: SetRecord, worktreeDir: string, only?: string): LaunchSpec[] {
  return ctx.config.services
    .filter(s => !only || s.name === only)
    .map(s => {
      const port = (set.resources[s.name] as { port: number }).port
      const command = s.command
        ? s.command.replace(/\{port\}/g, String(port))
        : adapterFor(s.type).defaultStartCommand(s, port)
      return { name: s.name, command, cwd: worktreeDir }
    })
}

export function selectStrategy(
  env: NodeJS.ProcessEnv & { __platform?: string }, force?: Strategy,
): Strategy {
  if (force) return force
  if (env.TMUX) return 'tmux'
  const platform = env.__platform ?? process.platform
  if (platform === 'darwin' && env.TERM_PROGRAM === 'iTerm.app') return 'iterm'
  return 'print'
}

export async function runLaunch(specs: LaunchSpec[], strategy: Strategy): Promise<void> {
  if (strategy === 'print') { console.log(renderPrint(specs)); return }
  if (strategy === 'tmux') { await runTmux(specs); return }
  await runIterm(specs)
}
```

- [ ] **Step 3: 写 tmux.ts + iterm.ts（薄封装，不单测真 spawn）**

```ts
// src/launch/tmux.ts
import { execa } from 'execa'
import type { LaunchSpec } from './index.js'
export async function runTmux(specs: LaunchSpec[]): Promise<void> {
  if (!specs.length) return
  const [first, ...rest] = specs
  const session = `bk-${first.cwd.split('/').pop()}`
  await execa('tmux', ['new-session', '-d', '-s', session, '-c', first.cwd, first.command])
  for (const s of rest)
    await execa('tmux', ['split-window', '-t', session, '-c', s.cwd, s.command])
  await execa('tmux', ['select-layout', '-t', session, 'tiled'])
  console.log(`tmux 会话 ${session} 已启动：tmux attach -t ${session}`)
}
```

```ts
// src/launch/iterm.ts
import { execa } from 'execa'
import type { LaunchSpec } from './index.js'
export async function runIterm(specs: LaunchSpec[]): Promise<void> {
  // 用 osascript 在新窗口逐个垂直分割运行命令
  const lines: string[] = ['tell application "iTerm2"', 'create window with default profile', 'tell current session of current window']
  specs.forEach((s, i) => {
    if (i > 0) lines.push('set newSession to (split vertically with default profile)', 'tell newSession')
    lines.push(`write text "cd ${s.cwd} && ${s.command.replace(/"/g, '\\"')}"`)
    if (i > 0) lines.push('end tell')
  })
  lines.push('end tell', 'end tell')
  await execa('osascript', lines.flatMap(l => ['-e', l]))
}
```

- [ ] **Step 4: 验证 launch 单测通过 + typecheck**

Run: `npx vitest run tests/launch && npm run typecheck` → PASS / 无错

- [ ] **Step 5: Commit**

```bash
git add src/launch tests/launch
git commit -m "feat(launch): start 策略选择 + print/tmux/iterm 三实现"
```

---

## Task 16: CLI 装配 + 输出/确认封装

**Files:**
- Create: `src/cli/output.ts`, `src/cli/context.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/context.test.ts`

**Interfaces:**
- Produces:
  - `src/cli/output.ts`：`info/warn/error/success(msg)`（带符号/颜色，写 stderr 除 success/数据）、`async confirm(msg): Promise<boolean>`（封装 @inquirer/prompts）。
  - `src/cli/context.ts`：`loadCtx(cwd?): Ctx`（discoverProjectRoot + loadConfig 组装）、`maxAttempts(ctx): number`（config 覆盖或默认 20）、`async runCommand(fn): Promise<void>`（统一 try/catch：`BkError` → 打印 message+remediation+退出码 1；其余 → 退出码 1）。
- Consumes: config（Task 3）、errors（Task 2）。

- [ ] **Step 1: 写 context.test.ts**

```ts
// tests/cli/context.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { loadCtx, maxAttempts } from '../../src/cli/context.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bk-'))
  writeFileSync(join(root, 'bk_config.yml'),
    'project_name: foo\nservices: {}\ninfra: {}\nallocation: { max_probe_attempts: 7 }\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('cli context', () => {
  it('loadCtx 组装 projectRoot + config', () => {
    const ctx = loadCtx(root)
    expect(ctx.projectRoot).toBe(root)
    expect(ctx.config.project_name).toBe('foo')
  })
  it('maxAttempts 读 config 覆盖值', () => expect(maxAttempts(loadCtx(root))).toBe(7))
})
```

- [ ] **Step 2: 运行验证失败 → 写 output.ts + context.ts**

Run: `npx vitest run tests/cli/context.test.ts` → FAIL

```ts
// src/cli/output.ts
import { confirm as inquirerConfirm } from '@inquirer/prompts'
export const info = (m: string) => console.error(`  ${m}`)
export const warn = (m: string) => console.error(`⚠ ${m}`)
export const error = (m: string) => console.error(`✖ ${m}`)
export const success = (m: string) => console.log(`✓ ${m}`)
export const plain = (m: string) => console.log(m)
export async function confirm(message: string): Promise<boolean> {
  return inquirerConfirm({ message, default: false })
}
```

```ts
// src/cli/context.ts
import { discoverProjectRoot } from '../config/discover.js'
import { loadConfig } from '../config/load.js'
import type { Ctx } from '../core/types.js'
import { BkError } from '../core/errors.js'
import { error as printError } from './output.js'

export function loadCtx(cwd: string = process.cwd()): Ctx {
  const projectRoot = discoverProjectRoot(cwd)
  return { projectRoot, config: loadConfig(projectRoot) }
}
export function maxAttempts(ctx: Ctx): number {
  return ctx.config.allocation?.max_probe_attempts ?? 20
}
export async function runCommand(fn: () => Promise<void>): Promise<void> {
  try { await fn() }
  catch (e) {
    if (e instanceof BkError) {
      printError(`${e.message}  [${e.code}]`)
      if (e.remediation) printError(`  → ${e.remediation}`)
    } else {
      printError((e as Error).message)
    }
    process.exitCode = 1
  }
}
```

- [ ] **Step 3: 验证通过 → 装配 index.ts（占位子命令，后续任务填充）**

```ts
// src/cli/index.ts
import { Command } from 'commander'
import { registerInit } from './commands/init.js'
import { registerAllocate } from './commands/allocate.js'
import { registerWorktree } from './commands/worktree.js'
import { registerList } from './commands/list.js'
import { registerStart } from './commands/start.js'
import { registerDestroy } from './commands/destroy.js'

const program = new Command()
program.name('bk').description('BookKeeper — 并行 worktree 的本地资源记账员').version('0.0.1')
registerInit(program)
registerAllocate(program)
registerWorktree(program)
registerList(program)
registerStart(program)
registerDestroy(program)
program.parseAsync(process.argv)
```

> 注：本步骤会因后续 command 模块尚未创建而无法构建——Task 17-21 会逐个补齐。先创建空的 `register*` 桩以通过 typecheck（每个文件 `export function registerX(p: Command) {}`），随任务替换为真实实现。

创建桩文件：`src/cli/commands/{init,allocate,worktree,list,start,destroy}.ts`，内容：
```ts
import type { Command } from 'commander'
export function registerInit(_p: Command) {}     // 各文件改对应名字
```

- [ ] **Step 4: typecheck 通过**

Run: `npm run typecheck` → 无错

- [ ] **Step 5: Commit**

```bash
git add src/cli tests/cli
git commit -m "feat(cli): 输出/确认封装 + ctx 装配 + runCommand 错误处理 + 子命令桩"
```

---

## Task 17: `bk allocate` / `bk deallocate`

**Files:**
- Modify: `src/cli/commands/allocate.ts`
- Test: `tests/cli/allocate.flow.test.ts`

**Interfaces:**
- Consumes: `loadCtx`、`maxAttempts`、`withState`、`activeProviders`、`resolveSet`、`provisionSet`、`buildSetRecord`、`collectEnv`、`writeEnvBlock`、`ensureGitignore`、`findSetByWorktree`、`deallocateInState`、`removeEnvBlock`。
- Produces: `registerAllocate(program)` 注册 `allocate` 与 `deallocate` 两个子命令。
  - `allocate`：在当前 worktree 目录分配资源、写 `.env`、写 state。
  - `deallocate`：反查当前 worktree 的 set、退回池子、移除 `.env` 块。
  - 导出 `async doAllocate(ctx, worktreeDir, branch): Promise<number>` 供 worktree create 复用。

- [ ] **Step 1: 写流程集成测（用 fake providers 注入点：直接测 doAllocate 的状态副作用）**

```ts
// tests/cli/allocate.flow.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { doAllocate } from '../../src/cli/commands/allocate.js'
import { readState } from '../../src/state/store.js'
import type { Ctx } from '../../src/core/types.js'

let home: string, wt: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  wt = mkdtempSync(join(tmpdir(), 'wt-'))
})
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(wt, { recursive: true, force: true }); delete process.env.BK_HOME })

const ctx = (): Ctx => ({ projectRoot: wt, config: {
  project_name: 'foo',
  services: [{ name: 'backend', type: 'django', port_base: 10000 }],
  infra: {},   // 仅 port provider，无外部依赖
}})

describe('doAllocate', () => {
  it('分配号 1、写 .env 标记块、写 state 为 allocated', async () => {
    const n = await doAllocate(ctx(), wt, 'feature/x')
    expect(n).toBe(1)
    const env = readFileSync(join(wt, '.env'), 'utf8')
    expect(env).toContain('# >>> bk managed >>>')
    const s = await readState('foo')
    expect(s.sets['1'].status).toBe('allocated')
    expect(s.sets['1'].owner?.worktree).toBe(wt)
    expect((s.sets['1'].resources['backend'] as any).port).toBe(10001)
  })
})
```

- [ ] **Step 2: 运行验证失败 → 写 allocate.ts**

Run: `npx vitest run tests/cli/allocate.flow.test.ts` → FAIL

```ts
// src/cli/commands/allocate.ts
import type { Command } from 'commander'
import { join } from 'node:path'
import type { Ctx } from '../../core/types.js'
import { withState } from '../../state/store.js'
import { activeProviders } from '../../providers/registry.js'
import { resolveSet, provisionSet, buildSetRecord, collectEnv } from '../../core/allocator.js'
import { writeEnvBlock, removeEnvBlock } from '../../inject/env.js'
import { ensureGitignore } from '../../inject/gitignore.js'
import { findSetByWorktree, deallocateInState } from '../../core/deallocator.js'
import { loadCtx, maxAttempts, runCommand } from '../context.js'
import { success, info } from '../output.js'
import { fingerprint } from '../../config/fingerprint.js'

export async function doAllocate(ctx: Ctx, worktreeDir: string, branch: string): Promise<number> {
  const providers = activeProviders(ctx)
  return withState(ctx.config.project_name, async (state) => {
    state.project_name = ctx.config.project_name
    state.config_fingerprint = fingerprint(ctx.config)
    const { n, reuse } = await resolveSet(providers, ctx, state, maxAttempts(ctx))
    if (!reuse) await provisionSet(providers, ctx, n)
    const owner = { worktree: worktreeDir, branch }
    state.sets[String(n)] = buildSetRecord(providers, ctx, n, owner)
    const env = collectEnv(providers, ctx, n)
    writeEnvBlock(join(worktreeDir, '.env'), env)
    ensureGitignore(ctx.projectRoot, ['.env'])
    return n
  })
}

export function registerAllocate(program: Command) {
  program.command('allocate').description('为当前 worktree 分配一套资源')
    .action(() => runCommand(async () => {
      const ctx = loadCtx()
      const n = await doAllocate(ctx, process.cwd(), '(manual)')
      success(`已分配 Set ${n}，并写入 .env`)
    }))

  program.command('deallocate').description('当前 worktree 解绑，资源退回池子')
    .action(() => runCommand(async () => {
      const ctx = loadCtx()
      const wt = process.cwd()
      await withState(ctx.config.project_name, (state) => {
        const n = findSetByWorktree(state, wt)
        if (!n) { info('当前 worktree 未分配资源'); return }
        deallocateInState(state, n)
        removeEnvBlock(join(wt, '.env'))
        success(`Set ${n} 已退回池子（资源保留）`)
      })
    }))
}
```

- [ ] **Step 3: 验证通过 + typecheck**

Run: `npx vitest run tests/cli/allocate.flow.test.ts && npm run typecheck` → PASS / 无错

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/allocate.ts tests/cli/allocate.flow.test.ts
git commit -m "feat(cli): bk allocate / deallocate（含 doAllocate 复用入口）"
```

---

## Task 18: `bk worktree create|delete`

**Files:**
- Modify: `src/cli/commands/worktree.ts`
- Test: `tests/cli/worktree.flow.test.ts`

**Interfaces:**
- Consumes: `addWorktree`、`removeWorktree`、`worktreeDirName`、`doAllocate`、`findSetByWorktree`、`deallocateInState`、`withState`、`loadCtx`、`confirm`。
- Produces: `registerWorktree(program)` 注册 `worktree create <branch> [--no-allocate]` 和 `worktree delete [dir]`。
  - create：在 `projectRoot` 的父目录建 `<project>.<branch>`，git worktree add，除非 `--no-allocate` 则 `doAllocate`。
  - delete：默认当前目录；先在 state 中 deallocate，再 git worktree remove。

- [ ] **Step 1: 写流程集成测（真 git 临时仓 + 仅 port provider）**

```ts
// tests/cli/worktree.flow.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join, dirname } from 'node:path'
import { createWorktree, deleteWorktree } from '../../src/cli/commands/worktree.js'
import { readState } from '../../src/state/store.js'
import type { Ctx } from '../../src/core/types.js'

let home: string, repo: string
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  repo = mkdtempSync(join(tmpdir(), 'foo-'))     // 充当 main 仓库（名字无关，project_name 来自 config）
  await execa('git', ['-C', repo, 'init', '-b', 'main'])
  await execa('git', ['-C', repo, 'config', 'user.email', 't@t.io'])
  await execa('git', ['-C', repo, 'config', 'user.name', 't'])
  writeFileSync(join(repo, 'f'), 'x')
  await execa('git', ['-C', repo, 'add', '.']); await execa('git', ['-C', repo, 'commit', '-m', 'i'])
})
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.BK_HOME
  rmSync(repo, { recursive: true, force: true }) })

const ctx = (): Ctx => ({ projectRoot: repo, config: {
  project_name: 'foo', services: [{ name: 'backend', type: 'django', port_base: 10000 }], infra: {} }})

describe('worktree create/delete', () => {
  it('create 建目录 ../foo.feature-x、分配资源', async () => {
    const dir = await createWorktree(ctx(), 'feature/x', { allocate: true })
    expect(dir).toBe(join(dirname(repo), 'foo.feature-x'))
    expect(existsSync(dir)).toBe(true)
    const s = await readState('foo')
    expect(Object.values(s.sets)[0].owner?.worktree).toBe(dir)
  })
  it('delete 退回池子并移除 worktree', async () => {
    const dir = await createWorktree(ctx(), 'feature/y', { allocate: true })
    await deleteWorktree(ctx(), dir)
    expect(existsSync(dir)).toBe(false)
    const s = await readState('foo')
    expect(Object.values(s.sets)[0].status).toBe('free')
  })
})
```

- [ ] **Step 2: 运行验证失败 → 写 worktree.ts**

Run: `npx vitest run tests/cli/worktree.flow.test.ts` → FAIL

```ts
// src/cli/commands/worktree.ts
import type { Command } from 'commander'
import { dirname, join, resolve } from 'node:path'
import type { Ctx } from '../../core/types.js'
import { addWorktree, removeWorktree, worktreeDirName } from '../../git/worktree.js'
import { doAllocate } from './allocate.js'
import { withState } from '../../state/store.js'
import { findSetByWorktree, deallocateInState } from '../../core/deallocator.js'
import { removeEnvBlock } from '../../inject/env.js'
import { loadCtx, runCommand } from '../context.js'
import { success, info } from '../output.js'

export async function createWorktree(ctx: Ctx, branch: string, opts: { allocate: boolean }): Promise<string> {
  const dir = join(dirname(ctx.projectRoot), worktreeDirName(ctx.config.project_name, branch))
  await addWorktree(ctx.projectRoot, branch, dir)
  if (opts.allocate) await doAllocate(ctx, dir, branch)
  return dir
}
export async function deleteWorktree(ctx: Ctx, dir: string): Promise<void> {
  await withState(ctx.config.project_name, (state) => {
    const n = findSetByWorktree(state, dir)
    if (n) deallocateInState(state, n)
  })
  removeEnvBlock(join(dir, '.env'))
  await removeWorktree(ctx.projectRoot, dir)
}

export function registerWorktree(program: Command) {
  const wt = program.command('worktree').description('管理 worktree')
  wt.command('create <branch>').description('创建 worktree（默认自动分配资源）')
    .option('--no-allocate', '只建 worktree，不分配资源')
    .action((branch: string, opts: { allocate: boolean }) => runCommand(async () => {
      const ctx = loadCtx()
      const dir = await createWorktree(ctx, branch, { allocate: opts.allocate })
      success(`worktree 已创建：${dir}${opts.allocate ? '（已分配资源、写好 .env）' : ''}`)
    }))
  wt.command('delete [dir]').description('删除 worktree（默认当前目录），资源退回池子')
    .action((dir: string | undefined) => runCommand(async () => {
      const ctx = loadCtx()
      const target = dir ? resolve(dir) : process.cwd()
      await deleteWorktree(ctx, target)
      success(`worktree 已删除：${target}（资源退回池子）`)
    }))
}
```

- [ ] **Step 3: 验证通过 + typecheck**

Run: `npx vitest run tests/cli/worktree.flow.test.ts && npm run typecheck` → PASS / 无错

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/worktree.ts tests/cli/worktree.flow.test.ts
git commit -m "feat(cli): bk worktree create/delete（一步分配 + 退回池子）"
```

---

## Task 19: `bk list`

**Files:**
- Modify: `src/cli/commands/list.ts`
- Test: `tests/cli/list.test.ts`

**Interfaces:**
- Consumes: `readState`、`loadCtx`、`pickNumber`。
- Produces: `registerList(program)`；导出 `renderList(state, projectName): string` 纯函数便于测试。展示：每个 allocated set（worktree + 资源），free 池，下一个可用号。

- [ ] **Step 1: 写 renderList 测试**

```ts
// tests/cli/list.test.ts
import { describe, it, expect } from 'vitest'
import { renderList } from '../../src/cli/commands/list.js'
import type { StateFile } from '../../src/state/schema.js'

const state: StateFile = { project_name: 'foo', config_fingerprint: '', sets: {
  '1': { status: 'allocated', owner: { worktree: '/wt/foo.x', branch: 'x' },
    resources: { backend: { port: 10001 }, postgres: { database: 'foo_1' }, minio: { bucket: 'foo-1' } }, created_at: 'x' },
  '3': { status: 'free', owner: null,
    resources: { backend: { port: 10003 }, postgres: { database: 'foo_3' } }, created_at: 'x' },
}}

describe('renderList', () => {
  it('含 allocated worktree、free 池、下一个号', () => {
    const out = renderList(state, 'foo')
    expect(out).toContain('foo.x')
    expect(out).toContain('foo_1')
    expect(out).toContain('Unallocated')
    expect(out).toContain('Set 3')
    expect(out).toMatch(/Next free number:\s*2/)
  })
})
```

- [ ] **Step 2: 运行验证失败 → 写 list.ts**

Run: `npx vitest run tests/cli/list.test.ts` → FAIL

```ts
// src/cli/commands/list.ts
import type { Command } from 'commander'
import type { StateFile } from '../../state/schema.js'
import { readState } from '../../state/store.js'
import { pickNumber } from '../../core/numbering.js'
import { loadCtx, runCommand } from '../context.js'
import { plain } from '../output.js'

function renderSet(n: string, r: StateFile['sets'][string]): string {
  const lines = [`  Set ${n}`]
  for (const [k, v] of Object.entries(r.resources)) {
    if (v && 'port' in v) lines.push(`    - ${k} ${v.port}`)
  }
  if (r.resources.postgres) lines.push(`    - PostgreSQL: ${r.resources.postgres.database}`)
  if (r.resources.redis?.prefix) lines.push(`    - Redis prefix: ${r.resources.redis.prefix}`)
  if (r.resources.redis?.db !== undefined) lines.push(`    - Redis db: ${r.resources.redis.db}`)
  if (r.resources.minio) lines.push(`    - MinIO bucket: ${r.resources.minio.bucket}`)
  return lines.join('\n')
}

export function renderList(state: StateFile, projectName: string): string {
  const out: string[] = [`Project Name: ${projectName}`, '']
  for (const [n, r] of Object.entries(state.sets)) {
    if (r.status !== 'allocated') continue
    out.push(`Worktree: ${r.owner?.worktree}  (Set ${n})`)
    out.push(renderSet(n, r).split('\n').slice(1).join('\n'), '')
  }
  const frees = Object.entries(state.sets).filter(([, r]) => r.status === 'free')
  if (frees.length) {
    out.push('Unallocated (in pool):')
    for (const [n, r] of frees) out.push(renderSet(n, r))
    out.push('')
  }
  out.push(`Next free number: ${pickNumber({ ...state, sets: Object.fromEntries(
    Object.entries(state.sets).filter(([, r]) => r.status === 'allocated')) }).n}`)
  return out.join('\n')
}

export function registerList(program: Command) {
  program.command('list').description('列出已分配 worktree、空闲池与下一个可用号')
    .action(() => runCommand(async () => {
      const ctx = loadCtx()
      plain(renderList(await readState(ctx.config.project_name), ctx.config.project_name))
    }))
}
```

注：`Next free number` 仅基于 allocated set 计算（忽略 free 池），表达"若不复用、下一个全新号是多少"，与 README 示例一致。

- [ ] **Step 3: 验证通过 + typecheck + Commit**

Run: `npx vitest run tests/cli/list.test.ts && npm run typecheck` → PASS / 无错

```bash
git add src/cli/commands/list.ts tests/cli/list.test.ts
git commit -m "feat(cli): bk list（allocated/free 池/下一个号）"
```

---

## Task 20: `bk destroy <n>`

**Files:**
- Modify: `src/cli/commands/destroy.ts`
- Test: `tests/cli/destroy.flow.test.ts`

**Interfaces:**
- Consumes: `withState`、`activeProviders`、`destroySet`、`confirm`、`loadCtx`。
- Produces: `registerDestroy(program)` 注册 `destroy <n> [--force] [--yes]`。流程：加载 set 信息 → 非 `--yes` 则 `confirm` 打印将删资源 → `destroySet`（护栏在内部）。

- [ ] **Step 1: 写流程测（仅 port provider，--yes 跳过确认）**

```ts
// tests/cli/destroy.flow.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { doDestroy } from '../../src/cli/commands/destroy.js'
import { withState, readState } from '../../src/state/store.js'
import type { Ctx } from '../../src/core/types.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home })
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.BK_HOME })

const ctx = (): Ctx => ({ projectRoot: '/x', config: {
  project_name: 'foo', services: [{ name: 'backend', type: 'django', port_base: 10000 }], infra: {} }})

describe('doDestroy', () => {
  it('free set 直接销毁', async () => {
    await withState('foo', (s) => { s.sets['2'] = { status: 'free', owner: null, resources: {}, created_at: 'x' } })
    await doDestroy(ctx(), 2, { force: false })
    expect((await readState('foo')).sets['2']).toBeUndefined()
  })
  it('allocated set 无 force 抛 SET_IN_USE', async () => {
    await withState('foo', (s) => { s.sets['2'] = { status: 'allocated', owner: { worktree: '/w', branch: 'x' }, resources: {}, created_at: 'x' } })
    await expect(doDestroy(ctx(), 2, { force: false })).rejects.toThrow(/SET_IN_USE/)
  })
})
```

- [ ] **Step 2: 运行验证失败 → 写 destroy.ts**

Run: `npx vitest run tests/cli/destroy.flow.test.ts` → FAIL

```ts
// src/cli/commands/destroy.ts
import type { Command } from 'commander'
import type { Ctx } from '../../core/types.js'
import { withState } from '../../state/store.js'
import { activeProviders } from '../../providers/registry.js'
import { destroySet } from '../../core/destroyer.js'
import { loadCtx, runCommand } from '../context.js'
import { confirm, success } from '../output.js'

export async function doDestroy(ctx: Ctx, n: number, opts: { force: boolean }): Promise<void> {
  await withState(ctx.config.project_name, (state) =>
    destroySet(activeProviders(ctx), ctx, state, n, opts))
}

export function registerDestroy(program: Command) {
  program.command('destroy <n>').description('销毁第 n 套资源（DROP DATABASE / 删桶，不可逆）')
    .option('--force', '即使正被 worktree 占用也销毁')
    .option('--yes', '跳过交互确认')
    .action((nStr: string, opts: { force?: boolean; yes?: boolean }) => runCommand(async () => {
      const ctx = loadCtx()
      const n = Number(nStr)
      if (!opts.yes) {
        const ok = await confirm(`确定销毁 Set ${n}？此操作不可逆（DROP DATABASE / 删桶）。`)
        if (!ok) { success('已取消'); return }
      }
      await doDestroy(ctx, n, { force: !!opts.force })
      success(`Set ${n} 已销毁`)
    }))
}
```

- [ ] **Step 3: 验证通过 + typecheck + Commit**

Run: `npx vitest run tests/cli/destroy.flow.test.ts && npm run typecheck` → PASS / 无错

```bash
git add src/cli/commands/destroy.ts tests/cli/destroy.flow.test.ts
git commit -m "feat(cli): bk destroy（确认 + 护栏 + 销毁）"
```

---

## Task 21: `bk start`

**Files:**
- Modify: `src/cli/commands/start.ts`
- Test: `tests/cli/start.test.ts`

**Interfaces:**
- Consumes: `loadCtx`、`readState`、`findSetByWorktree`、`buildLaunchSpecs`、`selectStrategy`、`runLaunch`。
- Produces: `registerStart(program)` 注册 `start [service] [--tmux] [--iterm] [--print]`。流程：反查当前 worktree 的 set → 构建 LaunchSpecs → 选策略 → run。未分配则报错提示先 allocate。

- [ ] **Step 1: 写 specs 构建测试（print 路径，不真 spawn）**

```ts
// tests/cli/start.test.ts
import { describe, it, expect } from 'vitest'
import { buildLaunchSpecs } from '../../src/launch/index.js'
import type { Ctx, SetRecord } from '../../src/core/types.js'

const ctx: Ctx = { projectRoot: '/x', config: {
  project_name: 'foo',
  services: [
    { name: 'backend', type: 'django', port_base: 10000 },
    { name: 'frontend', type: 'vite', port_base: 10100 },
  ], infra: {} }}
const set: SetRecord = { status: 'allocated', owner: { worktree: '/wt', branch: 'x' },
  resources: { backend: { port: 10002 }, frontend: { port: 10102 } }, created_at: 'x' }

describe('buildLaunchSpecs', () => {
  it('据 set 端口生成各 service 命令', () => {
    const specs = buildLaunchSpecs(ctx, set, '/wt')
    expect(specs[0].command).toBe('uv run python manage.py runserver 0.0.0.0:10002')
    expect(specs[1].command).toBe('npm run dev -- --port 10102')
    expect(specs[0].cwd).toBe('/wt')
  })
  it('only 过滤单个 service', () => {
    expect(buildLaunchSpecs(ctx, set, '/wt', 'frontend')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 运行验证失败 → 写 start.ts**

Run: `npx vitest run tests/cli/start.test.ts` → FAIL

```ts
// src/cli/commands/start.ts
import type { Command } from 'commander'
import { readState } from '../../state/store.js'
import { findSetByWorktree } from '../../core/deallocator.js'
import { buildLaunchSpecs, selectStrategy, runLaunch, type Strategy } from '../../launch/index.js'
import { loadCtx, runCommand } from '../context.js'
import { BkError, Codes } from '../../core/errors.js'

export function registerStart(program: Command) {
  program.command('start [service]').description('启动当前 worktree 的服务')
    .option('--tmux', '强制用 tmux 切 pane')
    .option('--iterm', '强制用 iTerm 切 pane')
    .option('--print', '只打印命令')
    .action((service: string | undefined, opts: { tmux?: boolean; iterm?: boolean; print?: boolean }) =>
      runCommand(async () => {
        const ctx = loadCtx()
        const wt = process.cwd()
        const state = await readState(ctx.config.project_name)
        const n = findSetByWorktree(state, wt)
        if (!n) throw new BkError(Codes.NOT_IN_WORKTREE,
          '当前 worktree 未分配资源', { remediation: '先运行 `bk allocate`' })
        const specs = buildLaunchSpecs(ctx, state.sets[n], wt, service)
        const force: Strategy | undefined =
          opts.tmux ? 'tmux' : opts.iterm ? 'iterm' : opts.print ? 'print' : undefined
        await runLaunch(specs, selectStrategy(process.env, force))
      }))
}
```

- [ ] **Step 3: 验证通过 + typecheck + Commit**

Run: `npx vitest run tests/cli/start.test.ts && npm run typecheck` → PASS / 无错

```bash
git add src/cli/commands/start.ts tests/cli/start.test.ts
git commit -m "feat(cli): bk start（反查 set + 构建命令 + 策略启动）"
```

---

## Task 22: `bk init`（侦测生成 config 草稿）

**Files:**
- Modify: `src/cli/commands/init.ts`
- Test: `tests/cli/init.test.ts`

**Interfaces:**
- Consumes: `detectType`、`ensureGitignore`、execa（可选探测 docker-compose）。
- Produces: `registerInit(program)`；导出 `buildConfigDraft(projectDir): string` —— 侦测 service 类型（扫子目录的特征文件）+ 生成带注释/占位的 YAML 草稿。已存在 `bk_config.yml` 则拒绝覆盖（除非 `--force`）。

- [ ] **Step 1: 写 buildConfigDraft 测试**

```ts
// tests/cli/init.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { buildConfigDraft } from '../../src/cli/commands/init.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proj-'))
  mkdirSync(join(dir, 'backend')); writeFileSync(join(dir, 'backend', 'manage.py'), '')
  mkdirSync(join(dir, 'frontend')); writeFileSync(join(dir, 'frontend', 'vite.config.ts'), '')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('buildConfigDraft', () => {
  it('侦测 backend=django、frontend=vite', () => {
    const yml = buildConfigDraft(dir)
    expect(yml).toContain('project_name:')
    expect(yml).toMatch(/backend:[\s\S]*type: django/)
    expect(yml).toMatch(/frontend:[\s\S]*type: vite/)
    expect(yml).toContain('port_base: 10000')
  })
})
```

- [ ] **Step 2: 运行验证失败 → 写 init.ts**

Run: `npx vitest run tests/cli/init.test.ts` → FAIL

```ts
// src/cli/commands/init.ts
import type { Command } from 'commander'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { detectType } from '../../frameworks/registry.js'
import { ensureGitignore } from '../../inject/gitignore.js'
import { runCommand } from '../context.js'
import { success, warn } from '../output.js'

export function buildConfigDraft(projectDir: string): string {
  const subdirs = readdirSync(projectDir)
    .filter(d => { try { return statSync(join(projectDir, d)).isDirectory() } catch { return false } })
  const detected: { name: string; type: string | null }[] = []
  if (detectType(projectDir)) detected.push({ name: basename(projectDir), type: detectType(projectDir) })
  for (const d of subdirs) detected.push({ name: d, type: detectType(join(projectDir, d)) })
  const services = detected.filter(d => d.type)

  const lines = ['---', `project_name: ${basename(projectDir)}`, '', 'services:']
  let base = 10000
  for (const s of services) {
    lines.push(`  ${s.name}:`, `    type: ${s.type}`, `    port_base: ${base}`)
    if (s.type === 'fastapi') lines.push(`    # app: app.main:app   # TODO fastapi 入口`)
    base += 100
  }
  if (!services.length) lines.push('  # TODO 未侦测到 service，请手动填写')
  lines.push('', 'infra:',
    '  postgres: { host: localhost, port: 5432, username: postgres, password: postgres }',
    '  redis: { host: localhost, port: 6379, isolation: key_prefix }',
    '  minio: { endpoint: localhost:9000, access_key: minioadmin, secret_key: minioadmin }')
  return lines.join('\n') + '\n'
}

export function registerInit(program: Command) {
  program.command('init').description('侦测当前项目并生成 bk_config.yml 草稿')
    .option('--force', '覆盖已存在的 bk_config.yml')
    .action((opts: { force?: boolean }) => runCommand(async () => {
      const dir = process.cwd()
      const target = join(dir, 'bk_config.yml')
      if (existsSync(target) && !opts.force) { warn('bk_config.yml 已存在，加 --force 覆盖'); return }
      writeFileSync(target, buildConfigDraft(dir))
      ensureGitignore(dir, ['.env'])
      success('已生成 bk_config.yml 草稿，请审核（尤其 infra 凭据与 fastapi app 字段）后再使用')
    }))
}
```

- [ ] **Step 3: 验证通过 + 全量测试 + typecheck**

Run: `npx vitest run tests/cli/init.test.ts` → PASS
Run: `npm test && npm run typecheck && npm run build` → 全绿、构建出 `dist/cli/index.js`

- [ ] **Step 4: 端到端冒烟（仅 port provider，无需 Docker）**

Run:
```bash
cd /tmp && rm -rf bksmoke && mkdir -p bksmoke/main && cd bksmoke/main
git init -b main -q && git config user.email t@t.io && git config user.name t
mkdir backend && touch backend/manage.py && git add -A && git commit -qm init
node <BK_REPO>/dist/cli/index.js init
# 编辑 bk_config.yml：删掉 infra 段只留 services（冒烟仅测 port），或保留但本地无 PG 会在 allocate 时按 INFRA_UNREACHABLE 报错
node <BK_REPO>/dist/cli/index.js worktree create feature/smoke --no-allocate
node <BK_REPO>/dist/cli/index.js list
```
Expected: init 生成 config；worktree create 在 `/tmp/bksmoke/main.feature-smoke` 建目录；list 打印结构。

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init.ts tests/cli/init.test.ts
git commit -m "feat(cli): bk init（框架侦测 + config 草稿 + .gitignore）"
```

---

## Self-Review

**Spec coverage（对照设计规格逐节）：**
- §2 技术栈 → Task 1 ✓
- §3 模块分解 → 全部 Task 覆盖每个模块 ✓
- §4.1 ResourceProvider → Task 5 接口 + Task 6-9 实现 ✓
- §4.2 FrameworkAdapter → Task 10 ✓
- §5 state.json 固化 + 锁 → Task 4（store）+ Task 13（buildSetRecord 固化快照）✓
- §6 allocate 数据流（选号→探活跳号→provision→回滚→写 .env→写 state）→ Task 13 + Task 17 ✓
- §7 错误分类 BkError → Task 2 + 各 provider 致命错 + Task 16 runCommand 退出码 ✓
- §7 destroy 护栏 → Task 14 + Task 20 ✓
- §8 测试策略（fake 单测 / testcontainers 集成 / 真 git）→ 各 Task 测试层 ✓
- §9 命令面（init/worktree/allocate/deallocate/start/list/destroy）→ Task 17-22 ✓
- 全局约束 .env 标记块 / .gitignore / 跳号上限 20 / BK_* 变量名 → Task 11 / Task 13+16 / 各 provider envVars ✓

**未覆盖项（有意延后，非首批）：** redis key_prefix 的 `SCAN+DEL` 清理（Task 8 标注首批不做）；config 漂移 warn（fingerprint 已存储，warn 提示可在后续迭代加）。

**Placeholder 扫描：** 无 TBD/TODO 留在实现代码中（init 草稿里的 `# TODO` 是有意写给用户的占位提示，非计划缺口）。

**类型一致性核对：**
- `ResourceProvider` 五方法签名（plan/probe/provision/destroy/envVars）在 Task 5 定义，Task 6-9 与 fakeProvider 一致 ✓
- `doAllocate(ctx, worktreeDir, branch)` Task 17 定义，Task 18 createWorktree 调用一致 ✓
- `SetRecord.resources` 形状 Task 2 定义，buildSetRecord（13）/ renderList（19）/ buildLaunchSpecs（15）读取一致 ✓
- `findSetByWorktree` / `deallocateInState` Task 14 定义，Task 17/18/21 使用一致 ✓
- `selectStrategy(env, force?)` Task 15 定义，Task 21 调用一致 ✓

---

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-06-20-bookkeeper.md`，共 22 个任务（脚手架 → 类型/错误 → config → state → providers → frameworks → inject → git → core 编排 → launch → CLI 各命令），每个任务自带 TDD 测试周期与提交点。
