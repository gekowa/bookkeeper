# post_allocate 钩子 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `bk` 的 allocate 流程加一个 per-service 的 `post_allocate` 钩子，在 `.env` 写好后自动跑用户配置的 setup 命令（如 `uv run migrate`、`npm install`）。

**Architecture:** 在 `bk_config.yml` 每个 service 下新增可选标量字段 `post_allocate`。新建独立执行器 `src/hooks/postAllocate.ts`，按 service 声明顺序在各自 `dir` 下用 `sh -c` 串行执行、fail-fast、注入该目录的 `BK_*` + `BK_N`。`doAllocate` 在 `withState`（持锁）返回**之后**、仅当 `reused === false` 时调用执行器（避免持锁期间跑长命令）。新增 `bk setup` 命令重跑钩子，`--no-hook` 旗标跳过钩子。

**Tech Stack:** Node 20+ / TypeScript / ESM、commander、execa v9、yaml、vitest。Python 项目命令一律 `uv`。

## Global Constraints

- 运行时：Node `>=20`，ESM（`"type": "module"`），所有相对 import 必须带 `.js` 后缀。
- 子进程：复用现有依赖 `execa`（v9），不引入新依赖。
- 钩子执行方式固定为 `sh -c "<命令>"`，单条标量命令，多步靠 `&&` 自串（不做列表形态）。
- 钩子只在 **allocate 实际写了 `.env`（`reused === false`）** 时跑；幂等命中已有资源不跑。
- 钩子失败：不回滚资源/worktree/.env，fail-fast 停在出错 service，向上抛 `BkError`（code `HOOK_FAILED`）。
- 钩子进程环境 = 继承 `process.env`（execa 默认 `extendEnv: true`）叠加 `{ ...该 dir 的 BK_* , BK_N }`。
- 错误信息一律中文；遵循现有 `BkError(code, message, { remediation })` 模式。
- 提交信息用 conventional commits + 中文描述（参考历史 `feat(...)`、`fix(...)`）。

---

### Task 1: 配置字段 `post_allocate` 透传

**Files:**
- Modify: `src/core/types.ts:4-12`（`ServiceConfig` 接口）
- Modify: `src/config/load.ts:17`（map→数组时透传）
- Test: `tests/config/load.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `ServiceConfig.post_allocate?: string`（后续所有任务从这里读命令）

- [ ] **Step 1: 写失败测试**

在 `tests/config/load.test.ts` 的 `describe('loadConfig', ...)` 内，最后一个 `it` 之后追加：

```ts
  it('透传 post_allocate 标量', () => {
    write(`project_name: foo
services:
  backend:
    type: django
    port_base: 10000
    dir: backend
    post_allocate: uv run python manage.py migrate && uv run python manage.py seed
infra: {}
`)
    expect(loadConfig(root).services[0].post_allocate)
      .toBe('uv run python manage.py migrate && uv run python manage.py seed')
  })

  it('未写 post_allocate → undefined', () => {
    write(`project_name: foo
services:
  backend:
    type: django
    port_base: 10000
infra: {}
`)
    expect(loadConfig(root).services[0].post_allocate).toBeUndefined()
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/config/load.test.ts`
Expected: FAIL — `expected undefined to be 'uv run ...'`（load.ts 尚未透传该字段，第一个新测试断言不通过）。

- [ ] **Step 3: 给 `ServiceConfig` 加字段**

在 `src/core/types.ts` 的 `ServiceConfig` 接口里，于 `envs?: Record<string, string>` 行之后加一行：

```ts
export interface ServiceConfig {
  name: string
  type: ServiceType
  port_base?: number
  command?: string
  app?: string
  dir?: string
  envs?: Record<string, string>
  post_allocate?: string
}
```

- [ ] **Step 4: 在 load.ts 透传**

把 `src/config/load.ts:17` 的 return 行改为（在结尾加 `post_allocate: s.post_allocate`）：

```ts
    return { name, type: s.type, port_base: s.port_base, command: s.command, app: s.app, dir: s.dir, envs: s.envs, post_allocate: s.post_allocate }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/config/load.test.ts`
Expected: PASS（全部用例通过）。

- [ ] **Step 6: 提交**

```bash
git add src/core/types.ts src/config/load.ts tests/config/load.test.ts
git commit -m "feat(config): ServiceConfig 新增 post_allocate 字段并透传"
```

---

### Task 2: 钩子执行器 `runPostAllocate`

**Files:**
- Modify: `src/core/errors.ts:6`（新增 `HOOK_FAILED` code）
- Create: `src/hooks/postAllocate.ts`
- Test: `tests/hooks/postAllocate.test.ts`

**Interfaces:**
- Consumes: `ServiceConfig.post_allocate`（Task 1）；`BkError`、`Codes.HOOK_FAILED`
- Produces: `runPostAllocate(ctx: Ctx, worktreeDir: string, dirEnvs: Map<string, Record<string, string>>, n: number): Promise<void>`
  - 按 `ctx.config.services` 顺序，对每个 `post_allocate` 非空的 service：在 `join(worktreeDir, svc.dir ?? '.')` 下 `execa('sh', ['-c', cmd], { cwd, env: { ...(dirEnvs.get(dir) ?? {}), BK_N: String(n) }, stdio: 'inherit', reject: false })`；`exitCode !== 0` 抛 `BkError(Codes.HOOK_FAILED, ...)`。

- [ ] **Step 1: 写失败测试**

创建 `tests/hooks/postAllocate.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { runPostAllocate } from '../../src/hooks/postAllocate.js'
import type { Ctx } from '../../src/core/types.js'

let wt: string
beforeEach(() => { wt = mkdtempSync(join(tmpdir(), 'wt-')) })
afterEach(() => rmSync(wt, { recursive: true, force: true }))

const ctx = (services: any[]): Ctx =>
  ({ projectRoot: wt, config: { project_name: 'foo', services, infra: {} } })

describe('runPostAllocate', () => {
  it('在 service 的 dir 下运行、注入 BK_N 与该目录的 BK_*', async () => {
    mkdirSync(join(wt, 'backend'))
    const c = ctx([{ name: 'backend', type: 'django', dir: 'backend',
      post_allocate: 'echo "$BK_N-$BK_DB_NAME" > out.txt' }])
    const dirEnvs = new Map([['backend', { BK_DB_NAME: 'foo_2' }]])
    await runPostAllocate(c, wt, dirEnvs, 2)
    expect(readFileSync(join(wt, 'backend', 'out.txt'), 'utf8').trim()).toBe('2-foo_2')
  })

  it('跳过没有 post_allocate 的 service', async () => {
    const c = ctx([{ name: 'frontend', type: 'vite', dir: '.' }])
    await expect(runPostAllocate(c, wt, new Map(), 1)).resolves.toBeUndefined()
  })

  it('fail-fast：第一个 service 失败抛 HOOK_FAILED 且不跑后续', async () => {
    const c = ctx([
      { name: 'a', type: 'django', dir: '.', post_allocate: 'exit 3' },
      { name: 'b', type: 'vite', dir: '.', post_allocate: 'echo hi > b.txt' },
    ])
    await expect(runPostAllocate(c, wt, new Map(), 1))
      .rejects.toMatchObject({ code: 'HOOK_FAILED' })
    expect(existsSync(join(wt, 'b.txt'))).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/hooks/postAllocate.test.ts`
Expected: FAIL — 无法解析模块 `../../src/hooks/postAllocate.js`（文件尚不存在）。

- [ ] **Step 3: 新增 HOOK_FAILED 错误码**

把 `src/core/errors.ts` 的 `Codes` 里 `NOT_IN_WORKTREE` 那行改为：

```ts
  NOT_IN_WORKTREE: 'NOT_IN_WORKTREE', HOOK_FAILED: 'HOOK_FAILED',
```

- [ ] **Step 4: 实现执行器**

创建 `src/hooks/postAllocate.ts`：

```ts
// src/hooks/postAllocate.ts
import { join } from 'node:path'
import { execa } from 'execa'
import type { Ctx } from '../core/types.js'
import { BkError, Codes } from '../core/errors.js'

/**
 * 按 service 声明顺序串行跑 post_allocate 钩子。
 * - 每条在该 service 的 dir 下用 sh -c 执行
 * - 进程环境 = process.env（execa 默认 extendEnv）叠加该 dir 的 BK_* 与 BK_N
 * - fail-fast：某条退出码非 0 立即抛 HOOK_FAILED，不跑后续
 */
export async function runPostAllocate(
  ctx: Ctx,
  worktreeDir: string,
  dirEnvs: Map<string, Record<string, string>>,
  n: number,
): Promise<void> {
  for (const svc of ctx.config.services) {
    const cmd = svc.post_allocate
    if (!cmd) continue
    const dir = svc.dir ?? '.'
    const cwd = join(worktreeDir, dir)
    const env = { ...(dirEnvs.get(dir) ?? {}), BK_N: String(n) }
    const result = await execa('sh', ['-c', cmd], { cwd, env, stdio: 'inherit', reject: false })
    if (result.exitCode !== 0) {
      throw new BkError(
        Codes.HOOK_FAILED,
        `service ${svc.name} 的 post_allocate 失败（exit code ${result.exitCode}）\n  命令：${cmd}\n  工作目录：${cwd}`,
        { remediation: '修复后用 bk setup 重跑' },
      )
    }
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/hooks/postAllocate.test.ts`
Expected: PASS（3 个用例全通过）。

- [ ] **Step 6: 提交**

```bash
git add src/core/errors.ts src/hooks/postAllocate.ts tests/hooks/postAllocate.test.ts
git commit -m "feat(hook): 新增 post_allocate 钩子执行器（per-service 串行 + fail-fast + 注入 BK_*/BK_N）"
```

---

### Task 3: 把钩子接进 `doAllocate` + `bk allocate --no-hook`

**Files:**
- Modify: `src/cli/commands/allocate.ts:46-88`（`doAllocate` 签名与调用；`allocate` 命令注册 `--no-hook`）
- Test: `tests/cli/allocate.flow.test.ts`

**Interfaces:**
- Consumes: `runPostAllocate`（Task 2）；同文件内已有的 `buildDirEnvs(ctx, names)`；已 import 的 `planNames`
- Produces: `doAllocate(ctx, worktreeDir, branch, providers?, opts?: { hook?: boolean })` —— `withState` 返回后，若 `opts.hook !== false && !result.reused`，跑 `runPostAllocate(ctx, worktreeDir, buildDirEnvs(ctx, names), result.n)`，其中 `names = planNames(providers, ctx, result.n)`

- [ ] **Step 1: 写失败测试**

在 `tests/cli/allocate.flow.test.ts` 顶部 import 区，把第 3 行的 fs 解构补上 `appendFileSync` 不需要——用 `readFileSync` 即可。然后在 `describe('doAllocate', ...)` 块内末尾（`})` 关闭 describe 之前）追加三个用例：

```ts
  it('reused=false → allocate 后跑 post_allocate（注入 BK_N）', async () => {
    mkdirSync(join(wt, 'backend'))
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend',
        post_allocate: 'echo "$BK_N" > hook.txt' }] } }
    await doAllocate(c, wt, 'feature/x', provs())
    expect(readFileSync(join(wt, 'backend', 'hook.txt'), 'utf8').trim()).toBe('1')
  })

  it('幂等命中（reused）不重跑钩子', async () => {
    mkdirSync(join(wt, 'backend'))
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend',
        post_allocate: 'echo x >> hook.txt' }] } }
    await doAllocate(c, wt, 'feature/x', provs())
    await doAllocate(c, wt, 'feature/x', provs())  // reused
    const lines = readFileSync(join(wt, 'backend', 'hook.txt'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
  })

  it('opts.hook=false → 跳过钩子', async () => {
    mkdirSync(join(wt, 'backend'))
    const c: Ctx = { projectRoot: wt, config: { project_name: 'foo', infra: {},
      services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend',
        post_allocate: 'echo x > hook.txt' }] } }
    await doAllocate(c, wt, 'feature/x', provs(), { hook: false })
    expect(existsSync(join(wt, 'backend', 'hook.txt'))).toBe(false)
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/cli/allocate.flow.test.ts`
Expected: FAIL — 第一个新用例找不到 `hook.txt`（`doAllocate` 尚未调用钩子）。

- [ ] **Step 3: import 执行器**

在 `src/cli/commands/allocate.ts` 顶部 import 区（`import { fingerprint } from '../../config/fingerprint.js'` 之后）加一行：

```ts
import { runPostAllocate } from '../../hooks/postAllocate.js'
```

- [ ] **Step 4: 改造 `doAllocate` 签名与调用**

把 `src/cli/commands/allocate.ts` 的 `doAllocate`（46-75 行整段）替换为：

```ts
export async function doAllocate(
  ctx: Ctx, worktreeDir: string, branch: string,
  providers: ResourceProvider[] = activeProviders(ctx),
  opts: { hook?: boolean } = {},
): Promise<{ n: number; reused: boolean; record: SetRecord }> {
  const result = await withState(ctx.config.project_name, async (state) => {
    // 幂等：当前目录若已分配，直接返回既有 Set，不重复创建资源、不覆盖 .env
    const existing = findSetByWorktree(state, worktreeDir)
    if (existing) return { n: Number(existing), reused: true, record: state.sets[existing] }

    state.project_name = ctx.config.project_name
    state.config_fingerprint = fingerprint(ctx.config)
    const { n, reuse } = await resolveSet(providers, ctx, state, maxAttempts(ctx))
    if (!reuse) await provisionSet(providers, ctx, n)
    try {
      const names = planNames(providers, ctx, n)
      state.sets[String(n)] = buildSetRecord(names, { worktree: worktreeDir, branch })
      writeServiceEnvs(ctx, worktreeDir, names)
      ensureGitignore(ctx.projectRoot, ['.env'])
      return { n, reused: false, record: state.sets[String(n)] }
    } catch (e) {
      if (!reuse) {
        for (const p of [...providers].reverse()) {
          try { await p.destroy(n, ctx) } catch { /* best-effort rollback */ }
        }
      }
      delete state.sets[String(n)]
      throw e
    }
  })

  // 钩子在持锁的 withState 之外、.env 写好之后跑：仅当本次实际分配（非幂等命中）且未 --no-hook
  if (opts.hook !== false && !result.reused) {
    const names = planNames(providers, ctx, result.n)
    await runPostAllocate(ctx, worktreeDir, buildDirEnvs(ctx, names), result.n)
  }
  return result
}
```

- [ ] **Step 5: 给 `allocate` 命令加 `--no-hook`**

把 `src/cli/commands/allocate.ts` 的 `registerAllocate` 里 `program.command('allocate')` 整段（77-88 行）替换为：

```ts
  program.command('allocate').description('为当前 worktree 分配一套资源')
    .option('--no-hook', '分配后不运行 post_allocate 钩子')
    .action((opts: { hook: boolean }) => runCommand(async () => {
      const ctx = loadCtx()
      const { n, reused, record } = await doAllocate(ctx, process.cwd(), '(manual)', undefined, { hook: opts.hook })
      if (reused) {
        info(`当前 worktree 已分配 Set ${n}，跳过重复分配。现有资源：`)
        plain(renderSet(String(n), record))
      } else {
        success(`已分配 Set ${n}，并写入 .env`)
      }
    }))
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/cli/allocate.flow.test.ts`
Expected: PASS（含三个新用例与原有全部用例）。

- [ ] **Step 7: 提交**

```bash
git add src/cli/commands/allocate.ts tests/cli/allocate.flow.test.ts
git commit -m "feat(allocate): 分配落地后跑 post_allocate 钩子（reused 跳过），allocate 加 --no-hook"
```

---

### Task 4: 把 `--no-hook` 接进 `bk worktree create`

**Files:**
- Modify: `src/cli/commands/worktree.ts:13-18`（`createWorktree` 签名）、`:31-37`（`create` 命令注册）
- Test: `tests/cli/worktree.flow.test.ts`

**Interfaces:**
- Consumes: `doAllocate(ctx, dir, branch, providers?, opts?)`（Task 3）
- Produces: `createWorktree(ctx, branch, opts: { allocate: boolean; hook?: boolean })` —— `opts.allocate` 时调用 `doAllocate(ctx, dir, branch, undefined, { hook: opts.hook })`

- [ ] **Step 1: 写失败测试**

在 `tests/cli/worktree.flow.test.ts` 的 `describe('worktree create/delete', ...)` 块内末尾（`})` 关闭 describe 之前）追加：

```ts
  it('create 默认跑 post_allocate；--no-hook 跳过', async () => {
    const c: Ctx = { projectRoot: repo, config: { project_name: 'foo',
      services: [{ name: 'backend', type: 'django', port_base: 10000,
        post_allocate: 'echo hi > hook.txt' }], infra: {} } }
    const dir = await createWorktree(c, 'feature/h', { allocate: true })
    expect(existsSync(join(dir, 'hook.txt'))).toBe(true)

    const dir2 = await createWorktree(c, 'feature/nh', { allocate: true, hook: false })
    expect(existsSync(join(dir2, 'hook.txt'))).toBe(false)
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/cli/worktree.flow.test.ts`
Expected: FAIL — `dir/hook.txt` 不存在（`createWorktree` 未透传 hook，且当前签名无 `hook` 字段）。

- [ ] **Step 3: 改 `createWorktree` 签名**

把 `src/cli/commands/worktree.ts:13-18` 的 `createWorktree` 替换为：

```ts
export async function createWorktree(ctx: Ctx, branch: string, opts: { allocate: boolean; hook?: boolean }): Promise<string> {
  const dir = join(dirname(ctx.projectRoot), worktreeDirName(ctx.config.project_name, branch))
  await addWorktree(ctx.projectRoot, branch, dir)
  if (opts.allocate) await doAllocate(ctx, dir, branch, undefined, { hook: opts.hook })
  return dir
}
```

- [ ] **Step 4: 给 `create` 命令加 `--no-hook`**

把 `src/cli/commands/worktree.ts` 的 `wt.command('create <branch>')` 整段（31-37 行）替换为：

```ts
  wt.command('create <branch>').description('创建 worktree（默认自动分配资源）')
    .option('--no-allocate', '只建 worktree，不分配资源')
    .option('--no-hook', '分配后不运行 post_allocate 钩子')
    .action((branch: string, opts: { allocate: boolean; hook: boolean }) => runCommand(async () => {
      const ctx = loadCtx()
      const dir = await createWorktree(ctx, branch, { allocate: opts.allocate, hook: opts.hook })
      success(`worktree 已创建：${dir}${opts.allocate ? '（已分配资源、写好 .env）' : ''}`)
    }))
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/cli/worktree.flow.test.ts`
Expected: PASS（含新用例与原有 create/delete 用例）。

- [ ] **Step 6: 提交**

```bash
git add src/cli/commands/worktree.ts tests/cli/worktree.flow.test.ts
git commit -m "feat(worktree): create 透传 --no-hook 到 post_allocate 钩子"
```

---

### Task 5: 新命令 `bk setup`（重跑钩子）

**Files:**
- Create: `src/cli/commands/setup.ts`
- Modify: `src/cli/index.ts`（import + 注册）
- Test: `tests/cli/setup.flow.test.ts`

**Interfaces:**
- Consumes: `readState`、`findSetByWorktree`、`activeProviders`、`planNames`、`buildDirEnvs`（从 `./allocate.js` 导出）、`runPostAllocate`、`BkError`/`Codes.NOT_IN_WORKTREE`
- Produces:
  - `doSetup(ctx: Ctx, worktreeDir: string): Promise<string>` —— 找当前 worktree 的 Set 号；找不到抛 `NOT_IN_WORKTREE`；找到则从既有 Set 派生 `names` 后重跑 `runPostAllocate`，返回 Set 号字符串
  - `registerSetup(program: Command): void`

- [ ] **Step 1: 写失败测试**

创建 `tests/cli/setup.flow.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { doAllocate } from '../../src/cli/commands/allocate.js'
import { doSetup } from '../../src/cli/commands/setup.js'
import { createPortProvider } from '../../src/providers/port.js'
import { fakeProvider } from '../helpers/fakeProvider.js'
import type { Ctx } from '../../src/core/types.js'

let home: string, wt: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  wt = mkdtempSync(join(tmpdir(), 'wt-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(wt, { recursive: true, force: true })
  delete process.env.BK_HOME
})

const provs = () => [createPortProvider(), fakeProvider({ kind: 'pg', plan: () => ({ database: 'foo_1' }) })]
const ctx = (): Ctx => ({ projectRoot: wt, config: { project_name: 'foo', infra: {},
  services: [{ name: 'backend', type: 'django', port_base: 10000, dir: 'backend',
    post_allocate: 'echo "$BK_N" > hook.txt' }] } })

describe('doSetup', () => {
  it('未分配的 worktree → 抛 NOT_IN_WORKTREE', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'bare-'))
    await expect(doSetup(ctx(), bare)).rejects.toMatchObject({ code: 'NOT_IN_WORKTREE' })
    rmSync(bare, { recursive: true, force: true })
  })

  it('已分配 → 重跑 post_allocate（注入 BK_N）', async () => {
    mkdirSync(join(wt, 'backend'))
    const c = ctx()
    await doAllocate(c, wt, 'feature/x', provs(), { hook: false })  // 先建好 Set，不跑钩子
    const n = await doSetup(c, wt)
    expect(n).toBe('1')
    expect(readFileSync(join(wt, 'backend', 'hook.txt'), 'utf8').trim()).toBe('1')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/cli/setup.flow.test.ts`
Expected: FAIL — 无法解析模块 `../../src/cli/commands/setup.js`（文件尚不存在）。

- [ ] **Step 3: 实现 `setup.ts`**

创建 `src/cli/commands/setup.ts`：

```ts
// src/cli/commands/setup.ts
import type { Command } from 'commander'
import type { Ctx } from '../../core/types.js'
import { readState } from '../../state/store.js'
import { findSetByWorktree } from '../../core/deallocator.js'
import { activeProviders } from '../../providers/registry.js'
import { planNames } from '../../core/allocator.js'
import { buildDirEnvs } from './allocate.js'
import { runPostAllocate } from '../../hooks/postAllocate.js'
import { BkError, Codes } from '../../core/errors.js'
import { loadCtx, runCommand } from '../context.js'
import { success } from '../output.js'

export async function doSetup(ctx: Ctx, worktreeDir: string): Promise<string> {
  const state = await readState(ctx.config.project_name)
  const n = findSetByWorktree(state, worktreeDir)
  if (!n)
    throw new BkError(Codes.NOT_IN_WORKTREE, '当前 worktree 未分配资源',
      { remediation: '先运行 bk allocate' })
  const providers = activeProviders(ctx)
  const names = planNames(providers, ctx, Number(n))
  await runPostAllocate(ctx, worktreeDir, buildDirEnvs(ctx, names), Number(n))
  return n
}

export function registerSetup(program: Command) {
  program.command('setup').description('对当前 worktree 重跑所有 service 的 post_allocate 钩子')
    .action(() => runCommand(async () => {
      const ctx = loadCtx()
      const n = await doSetup(ctx, process.cwd())
      success(`Set ${n}：post_allocate 钩子已重跑`)
    }))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/cli/setup.flow.test.ts`
Expected: PASS（2 个用例通过）。

- [ ] **Step 5: 在 CLI 注册 `setup` 命令**

在 `src/cli/index.ts` 的 import 区（`import { registerDestroy } from './commands/destroy.js'` 之后）加：

```ts
import { registerSetup } from './commands/setup.js'
```

并在 `registerDestroy(program)` 之后加一行：

```ts
registerSetup(program)
```

- [ ] **Step 6: 全量构建与测试确认 CLI 装配无误**

Run: `npm run typecheck && npm test`
Expected: PASS（typecheck 无错；全部测试通过）。

- [ ] **Step 7: 提交**

```bash
git add src/cli/commands/setup.ts src/cli/index.ts tests/cli/setup.flow.test.ts
git commit -m "feat(setup): 新增 bk setup 命令，对当前 worktree 重跑 post_allocate 钩子"
```

---

### Task 6: 文档更新（README）

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 前述全部行为（字段、触发时机、`bk setup`、`--no-hook`）
- Produces: 无（纯文档）

- [ ] **Step 1: 在配置示例里加 `post_allocate`**

在 `README.md` 的 `## 配置：bk_config.yml` 那段 YAML 里，给 `backend` 与 `frontend` 各加一行 `post_allocate`（放在各自 `dir` 行之后），例如 backend：

```yaml
    dir: backend          # 启动命令运行的目录（相对 worktree 根，缺省为根 `.`）
    post_allocate: uv run python manage.py migrate && uv run python manage.py seed   # 分配落地后自动跑（可选）
```

frontend：

```yaml
    dir: frontend
    post_allocate: npm install      # 分配落地后自动跑（可选）
```

- [ ] **Step 2: 新增「post_allocate 钩子」小节**

在 `## 配置注入` 小节末尾的时序保证 blockquote 之后，新增一个小节：

````markdown
## post_allocate 钩子（可选 setup 自动化）

bk 不懂也不代跑 migrate/seed/install——但提供一个**触发点**：在分配落地（`.env` 写好）后，按 service 跑你配置的一条命令。

```yaml
services:
  backend:
    type: django
    dir: backend
    post_allocate: uv run python manage.py migrate && uv run python manage.py seed
  frontend:
    type: vite
    dir: frontend
    post_allocate: npm install
```

- **per-service**：每条在该 service 的 `dir` 下运行（缺省为 worktree 根）。没写的 service 跳过。
- **标量单条**：多步用 `&&` 自串；走 `sh -c`，可用管道、重定向、`$BK_DB_NAME` 等环境变量。
- **触发时机**：每次 allocate **实际写了 `.env`** 之后跑（`bk worktree create` 与 `bk allocate` 都会触发）。**幂等命中已有资源时不跑**。`--no-hook` 可跳过。
- **环境注入**：跑钩子时把该目录的 `BK_*`（与写进 `.env` 的同一批）加 `BK_N`（资源集编号）注入进程环境。
- **失败处理**：**不回滚**（worktree/资源/.env 全保留），fail-fast 停在出错的 service。修好后用 `bk setup` 重跑，无需重建 worktree。
````

- [ ] **Step 3: 在「创建 worktree」补 `--no-hook`，并加 `bk setup`**

在 `### 创建 worktree` 小节，于 `--no-allocate` 说明那句之后补一句：

```markdown
加 `--no-hook` 可分配资源但不跑 `post_allocate` 钩子。
```

并在 `### 启动服务` 小节之前，新增：

````markdown
### 重跑 setup 钩子

```bash
bk setup
```

对**当前 worktree** 重跑所有 service 的 `post_allocate`。用于钩子失败修好后重跑，或单独重建 `node_modules`、补跑新加的 migration。当前 worktree 未分配资源时报错。
````

- [ ] **Step 4: 软化「bk 不代劳」表述**

在 `## 配置注入` 末尾时序保证 blockquote 里，把句末的 **「migrate/seed 何时跑由你决定，bk 不代劳。」** 改为：

```markdown
> **migrate/seed 何时跑由你决定**；想自动化可配 `post_allocate` 钩子（见下），bk 仍不理解其语义，只在 `.env` 就绪后忠实触发。
```

- [ ] **Step 5: 提交**

```bash
git add README.md
git commit -m "docs: 文档 post_allocate 钩子、bk setup 命令与 --no-hook 旗标"
```

---

## Self-Review

**1. Spec coverage:**

| Spec 条目 | 落实任务 |
|---|---|
| 设计§1 新增 `post_allocate` 字段（types + load 透传 + 缺省跳过） | Task 1 |
| 设计§3 执行语义（per-service、`dir`、`sh -c`、fail-fast、stdio 直通） | Task 2 |
| 设计§4 注入 `BK_*` + `BK_N` | Task 2（执行器）+ Task 3（`buildDirEnvs` 喂入） |
| 设计§5 失败不回滚、fail-fast、如实报告、非 0 退出 | Task 2（抛 `HOOK_FAILED`，钩子在 withState 之外）+ `runCommand` 既有 `process.exitCode=1` |
| 设计§2 触发时机（create/allocate 跑、reused 不跑、`--no-hook` 跳过） | Task 3（doAllocate + allocate 命令）+ Task 4（create 命令） |
| 设计§6 `bk setup` 重跑、未分配报错、从既有 Set 派生 names | Task 5 |
| 设计§7 `--no-hook` 旗标 | Task 3（allocate）+ Task 4（create） |
| 设计「影响的文件」README 更新 | Task 6 |
| 设计「测试」清单 | Task 1/2/3/4/5 的测试步骤逐条覆盖 |

无遗漏。

**2. Placeholder scan:** 无 TBD/TODO/"略"/"类似上文"。每个代码步骤均给出完整可粘贴代码。

**3. Type consistency:**
- `runPostAllocate(ctx, worktreeDir, dirEnvs, n)` 签名在 Task 2 定义，Task 3、Task 5 调用一致（`buildDirEnvs(...)` 产出 `Map<string, Record<string,string>>`，`n` 为 `number`）。
- `doAllocate(..., opts?: { hook?: boolean })` 在 Task 3 定义，Task 4（`{ hook: opts.hook }`）、Task 5（`{ hook: false }`）调用一致。
- `doSetup(ctx, worktreeDir): Promise<string>` 在 Task 5 定义并自用。
- `Codes.HOOK_FAILED` Task 2 新增，`Codes.NOT_IN_WORKTREE` 复用既有。
- `buildDirEnvs` 复用 `src/cli/commands/allocate.ts` 既有导出（Task 5 import），未改其签名。
