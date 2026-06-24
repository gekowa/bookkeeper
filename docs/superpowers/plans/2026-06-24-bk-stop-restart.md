# bk stop / restart 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `bk start` 补上对偶命令 `bk stop [service]` 与 `bk restart [service]`，停止/重启「由 bk 启动」的当前 worktree 服务。

**Architecture:** `bk start` 成功派发后，把运行句柄记到对应 `SetRecord.run`（iTerm 存每个 pane 的 `unique id`，tmux 存 session 名 + 每个 pane 的 `pane_id`）。`stop` 用这些句柄关闭 iTerm session / 杀 tmux pane|session；`restart` = stop + 重读配置后 start。所有句柄失效（用户手动关窗）均幂等容错。

**Tech Stack:** TypeScript (ESM, NodeNext)、commander、execa、vitest。沿用现有「`doX(ctx, worktreeDir, …)` 核心函数 + `register*` 薄包装」命令模式。

## Global Constraints

- **语言**：所有面向用户的输出与注释用简体中文（与现有代码一致）。
- **ESM 导入**：相对导入一律带 `.js` 后缀（NodeNext）。
- **副作用隔离**：真正起窗口/杀进程只经 `execa`；纯逻辑（脚本组装、run 记录计算）必须可在不调用 `execa` 的前提下单测。
- **状态写入**：改 state 一律走 `withState`（持锁 + 原子写）；启动/停止这类长耗时副作用在锁外执行，只有「写 run 记录」在锁内。
- **容错**：句柄失效（session/pane 不存在）时吞掉错误、视为已停，绝不让 stop/restart 报错退出非零。
- **测试命令**：`npm test`（vitest run）、`npm run typecheck`（tsc --noEmit）。
- **`print` 策略不记录 run**：`--print` 启动的服务 bk 无句柄，不归 bk 管。

---

## File Structure

- `src/core/types.ts` — 修改：新增 `RunService` / `RunHandle` / `RunRecord` 类型，`SetRecord` 加可选 `run?`。
- `src/core/run.ts` — 新建：纯函数 `mergeRun`（restart 重启后把新句柄并回 run 记录）。
- `src/launch/iterm.ts` — 修改：`buildItermScript` 末尾返回各 session 的 `unique id`；`runIterm` 返回 `string[]`（spec 顺序的 session id）。
- `src/launch/tmux.ts` — 修改：`runTmux` 用 `-P -F '#{pane_id}'` 捕获 pane id，返回 `{ session, paneIds }`。
- `src/launch/index.ts` — 修改：新增 `LaunchResult` 类型，`runLaunch` 返回运行句柄（`print` 返回 `null`）。
- `src/launch/stop.ts` — 新建：`stopRun(run, only?)` 关闭 iTerm session / 杀 tmux pane|session，返回剩余 run。
- `src/core/errors.ts` — 修改：新增错误码 `SERVICE_RUNNING`。
- `src/cli/commands/start.ts` — 修改：抽出 `doStart`，加「已在运行」护栏 + 派发成功后写 run。
- `src/cli/commands/stop.ts` — 新建：`doStop` + `registerStop`。
- `src/cli/commands/restart.ts` — 新建：`doRestart` + `registerRestart`。
- `src/cli/index.ts` — 修改：注册 `stop` / `restart`。
- `README.md` / `CHANGELOG.md` — 修改：文档。
- 测试：`tests/core/run.test.ts`、`tests/launch/iterm.test.ts`（扩展）、`tests/launch/tmux.test.ts`（新）、`tests/launch/stop.test.ts`（新）、`tests/cli/start.flow.test.ts`（新）、`tests/cli/stop.flow.test.ts`（新）、`tests/cli/restart.flow.test.ts`（新）。

---

## Task 1: 运行记录类型 + mergeRun 纯函数

**Files:**
- Modify: `src/core/types.ts:36-47`（`SetRecord` 区块）
- Create: `src/core/run.ts`
- Test: `tests/core/run.test.ts`

**Interfaces:**
- Produces:
  - `interface RunService { name: string; itermSessionId?: string; tmuxPaneId?: string }`
  - `interface RunHandle { strategy: 'tmux' | 'iterm'; tmuxSession?: string; services: RunService[] }`
  - `interface RunRecord extends RunHandle { startedAt: string }`
  - `SetRecord.run?: RunRecord`
  - `mergeRun(existing: RunRecord | undefined, launched: RunHandle | null, startedAt: string): RunRecord | null`

- [ ] **Step 1: 写失败测试** — `tests/core/run.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mergeRun } from '../../src/core/run.js'
import type { RunRecord, RunHandle } from '../../src/core/types.js'

const rec = (services: RunRecord['services']): RunRecord =>
  ({ strategy: 'iterm', startedAt: 't0', services })

describe('mergeRun', () => {
  it('launched 为 null（print）→ 原样返回 existing', () => {
    const e = rec([{ name: 'a', itermSessionId: 'A' }])
    expect(mergeRun(e, null, 't1')).toEqual(e)
  })
  it('existing 为空 → 用 launched 建新记录、带 startedAt', () => {
    const launched: RunHandle = { strategy: 'iterm', services: [{ name: 'a', itermSessionId: 'A' }] }
    expect(mergeRun(undefined, launched, 't1')).toEqual(
      { strategy: 'iterm', startedAt: 't1', services: [{ name: 'a', itermSessionId: 'A' }] })
  })
  it('strategy 不同 → 整体替换为 launched', () => {
    const e = rec([{ name: 'a', itermSessionId: 'A' }])
    const launched: RunHandle = { strategy: 'tmux', tmuxSession: 'bk-x', services: [{ name: 'a', tmuxPaneId: '%1' }] }
    expect(mergeRun(e, launched, 't1')).toEqual(
      { strategy: 'tmux', startedAt: 't1', tmuxSession: 'bk-x', services: [{ name: 'a', tmuxPaneId: '%1' }] })
  })
  it('同 strategy 单服务重启 → 替换该服务句柄、保留其余、保留原 startedAt', () => {
    const e = rec([{ name: 'a', itermSessionId: 'A' }, { name: 'b', itermSessionId: 'B' }])
    const launched: RunHandle = { strategy: 'iterm', services: [{ name: 'b', itermSessionId: 'B2' }] }
    expect(mergeRun(e, launched, 't1')).toEqual({
      strategy: 'iterm', startedAt: 't0',
      services: [{ name: 'a', itermSessionId: 'A' }, { name: 'b', itermSessionId: 'B2' }],
    })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/run.test.ts`
Expected: FAIL（`mergeRun` 未定义 / `src/core/run.js` 不存在）

- [ ] **Step 3: 在 `src/core/types.ts` 加类型**

在文件末尾（`SetRecord` 之后）追加：

```ts
export interface RunService {
  name: string
  itermSessionId?: string   // strategy === 'iterm'：iTerm session 的 unique id
  tmuxPaneId?: string       // strategy === 'tmux'：tmux pane id（如 %3），支持单服务停
}
export interface RunHandle {
  strategy: 'tmux' | 'iterm'   // 'print' 不记录（bk 无句柄）
  tmuxSession?: string         // strategy === 'tmux'：tmux session 名
  services: RunService[]
}
export interface RunRecord extends RunHandle {
  startedAt: string
}
```

并在 `SetRecord` 接口里加可选字段（在 `created_at: string` 行下方）：

```ts
  created_at: string
  run?: RunRecord
}
```

- [ ] **Step 4: 实现 `src/core/run.ts`**

```ts
import type { RunRecord, RunHandle } from './types.js'

// restart 重新派发后，把新句柄并回既有 run 记录。
// - launched 为 null（print 策略）：保持 existing 不变。
// - existing 为空或 strategy 变了：整体替换为 launched。
// - 同 strategy：替换 launched 涉及的服务句柄，保留其余服务与原 startedAt。
export function mergeRun(
  existing: RunRecord | undefined,
  launched: RunHandle | null,
  startedAt: string,
): RunRecord | null {
  if (!launched) return existing ?? null
  if (!existing || existing.strategy !== launched.strategy)
    return { ...launched, startedAt }
  const others = existing.services.filter(o => !launched.services.some(r => r.name === o.name))
  return {
    strategy: existing.strategy,
    startedAt: existing.startedAt,
    tmuxSession: launched.tmuxSession ?? existing.tmuxSession,
    services: [...others, ...launched.services],
  }
}
```

- [ ] **Step 5: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/core/run.test.ts && npm run typecheck`
Expected: PASS；typecheck 无错。

- [ ] **Step 6: 提交**

```bash
git add src/core/types.ts src/core/run.ts tests/core/run.test.ts
git commit -m "feat(run): RunRecord 类型与 mergeRun 纯函数"
```

---

## Task 2: 启动器捕获运行句柄

**Files:**
- Modify: `src/launch/iterm.ts:9-31`
- Modify: `src/launch/tmux.ts:4-13`
- Modify: `src/launch/index.ts:9-47`
- Test: `tests/launch/iterm.test.ts`（扩展）、`tests/launch/tmux.test.ts`（新）

**Interfaces:**
- Consumes: `RunService`, `RunHandle`（Task 1）；`planGrid`（现有）。
- Produces:
  - `buildItermScript(specs, plan)` 末尾新增一行 `return {unique id of s<sid0>, …}`（在 `end tell` 之前）。
  - `runIterm(specs: LaunchSpec[]): Promise<string[]>` —— 返回 spec 顺序的 session unique id。
  - `runTmux(specs: LaunchSpec[]): Promise<{ session: string; paneIds: string[] }>`
  - `type LaunchResult = RunHandle | null`
  - `runLaunch(specs: LaunchSpec[], strategy: Strategy): Promise<LaunchResult>`

- [ ] **Step 1: 扩展 iterm 测试** — 在 `tests/launch/iterm.test.ts` 的 `describe('buildItermScript')` 内追加：

```ts
  it('末尾按 order 返回各 session 的 unique id（在 end tell 之前）', () => {
    const lines = buildItermScript(mk(3), planGrid(3)) // order = [0,2,1]
    const ret = lines[lines.length - 2]
    expect(ret).toBe('return {unique id of s0, unique id of s2, unique id of s1}')
    expect(lines[lines.length - 1]).toBe('end tell')
  })
  it('n=1：返回单个 unique id', () => {
    const lines = buildItermScript(mk(1), planGrid(1))
    expect(lines[lines.length - 2]).toBe('return {unique id of s0}')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/launch/iterm.test.ts`
Expected: FAIL（当前 `end tell` 前没有 `return` 行）

- [ ] **Step 3: 改 `buildItermScript`（`src/launch/iterm.ts`）**

把函数结尾的 `lines.push('end tell')` 替换为：

```ts
  const ids = specs.map((_, k) => `unique id of s${plan.order[k]}`)
  lines.push(`return {${ids.join(', ')}}`)
  lines.push('end tell')
  return lines
}
```

- [ ] **Step 4: 跑 iterm 测试确认通过**

Run: `npx vitest run tests/launch/iterm.test.ts`
Expected: PASS

- [ ] **Step 5: 改 `runIterm` 返回 session id（`src/launch/iterm.ts`）**

```ts
export async function runIterm(specs: LaunchSpec[]): Promise<string[]> {
  if (!specs.length) return [] // 对齐 tmux：无 service 不开窗
  const lines = buildItermScript(specs, planGrid(specs.length))
  const { stdout } = await execa('osascript', lines.flatMap(l => ['-e', l]))
  // AppleScript 列表以 ", " 分隔；iTerm unique id 不含逗号
  return stdout.split(', ').map(s => s.trim()).filter(Boolean)
}
```

- [ ] **Step 6: 写 tmux 测试** — `tests/launch/tmux.test.ts`（新）

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'
import { runTmux } from '../../src/launch/tmux.js'
import type { LaunchSpec } from '../../src/launch/index.js'

const mockExeca = vi.mocked(execa)
const spec = (name: string, cwd: string): LaunchSpec => ({ name, command: `run ${name}`, cwd })

beforeEach(() => {
  mockExeca.mockReset()
  // new-session / split-window 用 -P -F '#{pane_id}' 打印 pane id；select-layout 无 stdout
  let pane = 0
  mockExeca.mockImplementation(((_file: string, args: string[]) => {
    if (args[0] === 'new-session' || args[0] === 'split-window')
      return Promise.resolve({ stdout: `%${++pane}` })
    return Promise.resolve({ stdout: '' })
  }) as unknown as typeof execa)
})

describe('runTmux', () => {
  it('new-session 与 split-window 都带 -P -F #{pane_id}', async () => {
    await runTmux([spec('backend', '/wt/backend'), spec('frontend', '/wt/frontend')])
    const calls = mockExeca.mock.calls.map(c => (c[1] as string[]))
    expect(calls[0]).toEqual(expect.arrayContaining(['new-session', '-P', '-F', '#{pane_id}']))
    expect(calls[1]).toEqual(expect.arrayContaining(['split-window', '-P', '-F', '#{pane_id}']))
  })
  it('返回 session 名与按 spec 顺序的 paneIds', async () => {
    const r = await runTmux([spec('backend', '/wt/backend'), spec('frontend', '/wt/frontend')])
    expect(r.session).toBe('bk-backend')
    expect(r.paneIds).toEqual(['%1', '%2'])
  })
  it('空 specs → 空结果、不调用 tmux', async () => {
    const r = await runTmux([])
    expect(r).toEqual({ session: '', paneIds: [] })
    expect(mockExeca).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 7: 跑 tmux 测试确认失败**

Run: `npx vitest run tests/launch/tmux.test.ts`
Expected: FAIL（`runTmux` 现返回 void、命令无 `-P -F`）

- [ ] **Step 8: 改 `runTmux`（`src/launch/tmux.ts`）**

整体替换文件内容：

```ts
import { execa } from 'execa'
import type { LaunchSpec } from './index.js'

export async function runTmux(specs: LaunchSpec[]): Promise<{ session: string; paneIds: string[] }> {
  if (!specs.length) return { session: '', paneIds: [] }
  const [first, ...rest] = specs
  const session = `bk-${first.cwd.split('/').pop()}`
  const paneIds: string[] = []
  const r0 = await execa('tmux',
    ['new-session', '-d', '-s', session, '-c', first.cwd, '-P', '-F', '#{pane_id}', first.command])
  paneIds.push(r0.stdout.trim())
  for (const s of rest) {
    const r = await execa('tmux',
      ['split-window', '-t', session, '-c', s.cwd, '-P', '-F', '#{pane_id}', s.command])
    paneIds.push(r.stdout.trim())
  }
  await execa('tmux', ['select-layout', '-t', session, 'tiled'])
  console.log(`tmux 会话 ${session} 已启动：tmux attach -t ${session}`)
  return { session, paneIds }
}
```

- [ ] **Step 9: 跑 tmux 测试确认通过**

Run: `npx vitest run tests/launch/tmux.test.ts`
Expected: PASS

- [ ] **Step 10: 改 `runLaunch` 返回句柄（`src/launch/index.ts`）**

在文件顶部 import 区加：

```ts
import type { Ctx, SetRecord, RunHandle, RunService } from '../core/types.js'
```

（替换原 `import type { Ctx, SetRecord } from '../core/types.js'`）

在 `export type Strategy` 行下方新增：

```ts
export type LaunchResult = RunHandle | null
```

把 `runLaunch` 整体替换为：

```ts
export async function runLaunch(specs: LaunchSpec[], strategy: Strategy): Promise<LaunchResult> {
  if (strategy === 'print') { console.log(renderPrint(specs)); return null }
  if (strategy === 'tmux') {
    const { session, paneIds } = await runTmux(specs)
    const services: RunService[] = specs.map((s, i) => ({ name: s.name, tmuxPaneId: paneIds[i] }))
    return { strategy: 'tmux', tmuxSession: session, services }
  }
  const ids = await runIterm(specs)
  const services: RunService[] = specs.map((s, i) => ({ name: s.name, itermSessionId: ids[i] }))
  return { strategy: 'iterm', services }
}
```

- [ ] **Step 11: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: PASS（`start.ts` 仍调用 `runLaunch` 并忽略返回值，照常编译；现有 launch/print/select 测试不受影响）

- [ ] **Step 12: 提交**

```bash
git add src/launch/iterm.ts src/launch/tmux.ts src/launch/index.ts tests/launch/iterm.test.ts tests/launch/tmux.test.ts
git commit -m "feat(launch): 捕获 iTerm session id 与 tmux pane id，runLaunch 返回运行句柄"
```

---

## Task 3: stopRun（关闭句柄，幂等容错）

**Files:**
- Create: `src/launch/stop.ts`
- Test: `tests/launch/stop.test.ts`

**Interfaces:**
- Consumes: `RunRecord`（Task 1）。
- Produces: `stopRun(run: RunRecord, only?: string): Promise<RunRecord | null>` —— 关闭目标服务句柄，返回剩余 run（无剩余则 `null`）。

行为约定：
- `only` 缺省 = 停全部；`tmux` 且停全部 → `kill-session`（更干净，含无端口 worker）。
- `iterm` → 对每个目标 `tell session id "X" to close`；`tmux` 停单个 → `kill-pane -t X`。
- 任何 `execa` 抛错（session/pane 已不存在）都吞掉，视为已停。

- [ ] **Step 1: 写失败测试** — `tests/launch/stop.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'
import { stopRun } from '../../src/launch/stop.js'
import type { RunRecord } from '../../src/core/types.js'

const mockExeca = vi.mocked(execa)
beforeEach(() => { mockExeca.mockReset(); mockExeca.mockResolvedValue({ stdout: '' } as never) })

const iterm = (): RunRecord => ({ strategy: 'iterm', startedAt: 't',
  services: [{ name: 'a', itermSessionId: 'A' }, { name: 'b', itermSessionId: 'B' }] })
const tmux = (): RunRecord => ({ strategy: 'tmux', startedAt: 't', tmuxSession: 'bk-x',
  services: [{ name: 'a', tmuxPaneId: '%1' }, { name: 'b', tmuxPaneId: '%2' }] })

describe('stopRun', () => {
  it('iterm 停全部 → 逐个 close session，返回 null', async () => {
    const rem = await stopRun(iterm())
    const scripts = mockExeca.mock.calls.map(c => (c[1] as string[])[1])
    expect(scripts[0]).toBe('tell application "iTerm2" to tell session id "A" to close')
    expect(scripts[1]).toBe('tell application "iTerm2" to tell session id "B" to close')
    expect(rem).toBeNull()
  })
  it('iterm 停单个 → 只 close 该 session，返回剩余', async () => {
    const rem = await stopRun(iterm(), 'a')
    expect(mockExeca).toHaveBeenCalledTimes(1)
    expect((mockExeca.mock.calls[0][1] as string[])[1]).toContain('"A"')
    expect(rem).toEqual({ strategy: 'iterm', startedAt: 't', services: [{ name: 'b', itermSessionId: 'B' }] })
  })
  it('tmux 停全部 → kill-session，返回 null', async () => {
    const rem = await stopRun(tmux())
    expect(mockExeca).toHaveBeenCalledWith('tmux', ['kill-session', '-t', 'bk-x'])
    expect(rem).toBeNull()
  })
  it('tmux 停单个 → kill-pane，返回剩余', async () => {
    const rem = await stopRun(tmux(), 'b')
    expect(mockExeca).toHaveBeenCalledWith('tmux', ['kill-pane', '-t', '%2'])
    expect(rem).toEqual({ strategy: 'tmux', startedAt: 't', tmuxSession: 'bk-x', services: [{ name: 'a', tmuxPaneId: '%1' }] })
  })
  it('句柄已失效（execa 抛错）→ 吞错、仍返回剩余/ null', async () => {
    mockExeca.mockRejectedValue(new Error('session not found'))
    await expect(stopRun(iterm())).resolves.toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/launch/stop.test.ts`
Expected: FAIL（`src/launch/stop.js` 不存在）

- [ ] **Step 3: 实现 `src/launch/stop.ts`**

```ts
import { execa } from 'execa'
import type { RunRecord, RunService } from '../core/types.js'

// 容错执行：句柄已失效（session/pane 不存在）时吞错，视为已停。
async function tryExec(file: string, args: string[]): Promise<void> {
  try { await execa(file, args) } catch { /* 已不存在，视为已停 */ }
}

async function closeService(strategy: RunRecord['strategy'], s: RunService): Promise<void> {
  if (strategy === 'iterm' && s.itermSessionId)
    await tryExec('osascript',
      ['-e', `tell application "iTerm2" to tell session id "${s.itermSessionId}" to close`])
  else if (strategy === 'tmux' && s.tmuxPaneId)
    await tryExec('tmux', ['kill-pane', '-t', s.tmuxPaneId])
}

// 停掉 run 中的指定服务（only 缺省 = 全部），返回剩余 run（无剩余则 null）。
export async function stopRun(run: RunRecord, only?: string): Promise<RunRecord | null> {
  const targets = only ? run.services.filter(s => s.name === only) : run.services
  if (run.strategy === 'tmux' && !only && run.tmuxSession) {
    await tryExec('tmux', ['kill-session', '-t', run.tmuxSession])
  } else {
    for (const s of targets) await closeService(run.strategy, s)
  }
  const remaining = run.services.filter(s => !targets.includes(s))
  return remaining.length ? { ...run, services: remaining } : null
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/launch/stop.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/launch/stop.ts tests/launch/stop.test.ts
git commit -m "feat(launch): stopRun 关闭 iTerm session / tmux pane|session，幂等容错"
```

---

## Task 4: doStart 护栏 + 写 run 记录

**Files:**
- Modify: `src/core/errors.ts:1-7`
- Modify: `src/cli/commands/start.ts`（整体重写）
- Test: `tests/cli/start.flow.test.ts`（新）

**Interfaces:**
- Consumes: `runLaunch`/`LaunchResult`/`selectStrategy`/`buildLaunchSpecs`（Task 2）、`findSetByWorktree`、`readState`/`withState`。
- Produces: `doStart(ctx: Ctx, worktreeDir: string, service?: string, force?: Strategy, env?: NodeJS.ProcessEnv): Promise<void>`；`Codes.SERVICE_RUNNING`。

- [ ] **Step 1: 加错误码（`src/core/errors.ts`）**

把 `NOT_IN_WORKTREE: 'NOT_IN_WORKTREE', HOOK_FAILED: 'HOOK_FAILED',` 那行改为：

```ts
  NOT_IN_WORKTREE: 'NOT_IN_WORKTREE', HOOK_FAILED: 'HOOK_FAILED',
  SERVICE_RUNNING: 'SERVICE_RUNNING',
```

- [ ] **Step 2: 写失败测试** — `tests/cli/start.flow.test.ts`（新）

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { withState, readState } from '../../src/state/store.js'
import { doStart } from '../../src/cli/commands/start.js'
import type { Ctx, SetRecord } from '../../src/core/types.js'

const mockExeca = vi.mocked(execa)
let home: string
const wt = '/wt'
const ctx: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
  services: [{ name: 'backend', type: 'django', port_base: 10000 },
             { name: 'frontend', type: 'vite', port_base: 10100 }] } }

const seed = (run?: SetRecord['run']) => withState('foo', s => {
  s.sets['2'] = { status: 'allocated', owner: { worktree: wt, branch: 'x' },
    resources: { backend: { port: 10002 }, frontend: { port: 10102 } }, created_at: 't', run }
})

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  mockExeca.mockReset(); mockExeca.mockResolvedValue({ stdout: 'SID-backend, SID-frontend' } as never) })
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.BK_HOME })

describe('doStart', () => {
  it('未分配 worktree → 抛 NOT_IN_WORKTREE', async () => {
    await expect(doStart(ctx, '/nope', undefined, 'iterm')).rejects.toMatchObject({ code: 'NOT_IN_WORKTREE' })
  })
  it('已有 run → 抛 SERVICE_RUNNING', async () => {
    await seed({ strategy: 'iterm', startedAt: 't', services: [{ name: 'backend', itermSessionId: 'X' }] })
    await expect(doStart(ctx, wt, undefined, 'iterm')).rejects.toMatchObject({ code: 'SERVICE_RUNNING' })
  })
  it('iterm 启动成功 → 写入 run（含 session id）', async () => {
    await seed()
    await doStart(ctx, wt, undefined, 'iterm')
    const s = await readState('foo')
    expect(s.sets['2'].run).toMatchObject({ strategy: 'iterm',
      services: [{ name: 'backend', itermSessionId: 'SID-backend' }, { name: 'frontend', itermSessionId: 'SID-frontend' }] })
    expect(typeof s.sets['2'].run!.startedAt).toBe('string')
  })
  it('print 策略 → 不写 run', async () => {
    await seed()
    await doStart(ctx, wt, undefined, 'print')
    const s = await readState('foo')
    expect(s.sets['2'].run).toBeUndefined()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/cli/start.flow.test.ts`
Expected: FAIL（`doStart` 未导出）

- [ ] **Step 4: 重写 `src/cli/commands/start.ts`**

```ts
import type { Command } from 'commander'
import type { Ctx } from '../../core/types.js'
import { readState, withState } from '../../state/store.js'
import { findSetByWorktree } from '../../core/deallocator.js'
import { buildLaunchSpecs, selectStrategy, runLaunch, type Strategy } from '../../launch/index.js'
import { loadCtx, runCommand } from '../context.js'
import { BkError, Codes } from '../../core/errors.js'

export async function doStart(
  ctx: Ctx, worktreeDir: string, service?: string,
  force?: Strategy, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const project = ctx.config.project_name
  const state = await readState(project)
  const n = findSetByWorktree(state, worktreeDir)
  if (!n) throw new BkError(Codes.NOT_IN_WORKTREE,
    '当前 worktree 未分配资源', { remediation: '先运行 `bk allocate`' })
  if (state.sets[n].run)
    throw new BkError(Codes.SERVICE_RUNNING,
      '当前 worktree 已有服务在运行', { remediation: '改用 `bk restart`' })
  const specs = buildLaunchSpecs(ctx, state.sets[n], worktreeDir, service)
  const launched = await runLaunch(specs, selectStrategy(env, force))
  if (launched)
    await withState(project, s => {
      s.sets[n].run = { ...launched, startedAt: new Date().toISOString() }
    })
}

export function registerStart(program: Command) {
  program.command('start [service]').description('启动当前 worktree 的服务')
    .option('--tmux', '强制用 tmux 切 pane')
    .option('--iterm', '强制用 iTerm 切 pane')
    .option('--print', '只打印命令')
    .action((service: string | undefined, opts: { tmux?: boolean; iterm?: boolean; print?: boolean }) =>
      runCommand(async () => {
        const force: Strategy | undefined =
          opts.tmux ? 'tmux' : opts.iterm ? 'iterm' : opts.print ? 'print' : undefined
        await doStart(loadCtx(), process.cwd(), service, force)
      }))
}
```

- [ ] **Step 5: 跑测试确认通过 + 全量**

Run: `npx vitest run tests/cli/start.flow.test.ts && npm test && npm run typecheck`
Expected: PASS（既有 `tests/cli/start.test.ts` 只测 `buildLaunchSpecs`，不受影响）

- [ ] **Step 6: 提交**

```bash
git add src/core/errors.ts src/cli/commands/start.ts tests/cli/start.flow.test.ts
git commit -m "feat(start): 已运行护栏 + 派发成功后记录 run 句柄"
```

---

## Task 5: bk stop 命令

**Files:**
- Create: `src/cli/commands/stop.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/stop.flow.test.ts`（新）

**Interfaces:**
- Consumes: `stopRun`（Task 3）、`findSetByWorktree`、`readState`/`withState`、`info`/`success`。
- Produces: `doStop(ctx: Ctx, worktreeDir: string, service?: string): Promise<void>`；`registerStop(program)`。

- [ ] **Step 1: 写失败测试** — `tests/cli/stop.flow.test.ts`

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { withState, readState } from '../../src/state/store.js'
import { doStop } from '../../src/cli/commands/stop.js'
import type { Ctx, SetRecord } from '../../src/core/types.js'

const mockExeca = vi.mocked(execa)
let home: string
const wt = '/wt'
const ctx: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
  services: [{ name: 'backend', type: 'django', port_base: 10000 },
             { name: 'frontend', type: 'vite', port_base: 10100 }] } }

const seed = (run?: SetRecord['run']) => withState('foo', s => {
  s.sets['2'] = { status: 'allocated', owner: { worktree: wt, branch: 'x' },
    resources: { backend: { port: 10002 }, frontend: { port: 10102 } }, created_at: 't', run }
})
const itermRun = (): SetRecord['run'] => ({ strategy: 'iterm', startedAt: 't',
  services: [{ name: 'backend', itermSessionId: 'A' }, { name: 'frontend', itermSessionId: 'B' }] })

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  mockExeca.mockReset(); mockExeca.mockResolvedValue({ stdout: '' } as never) })
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.BK_HOME })

describe('doStop', () => {
  it('未分配 worktree → 抛 NOT_IN_WORKTREE', async () => {
    await expect(doStop(ctx, '/nope')).rejects.toMatchObject({ code: 'NOT_IN_WORKTREE' })
  })
  it('无 run → 不报错、不调用 execa', async () => {
    await seed(undefined)
    await expect(doStop(ctx, wt)).resolves.toBeUndefined()
    expect(mockExeca).not.toHaveBeenCalled()
  })
  it('停全部 → close 两个 session、清空 run', async () => {
    await seed(itermRun())
    await doStop(ctx, wt)
    expect(mockExeca).toHaveBeenCalledTimes(2)
    const s = await readState('foo')
    expect(s.sets['2'].run).toBeUndefined()
  })
  it('停单个 → 只 close 该 session、run 保留其余', async () => {
    await seed(itermRun())
    await doStop(ctx, wt, 'backend')
    expect(mockExeca).toHaveBeenCalledTimes(1)
    const s = await readState('foo')
    expect(s.sets['2'].run!.services).toEqual([{ name: 'frontend', itermSessionId: 'B' }])
  })
  it('停一个未在运行的 service → 不报错、不动 run、不调用 execa', async () => {
    await seed(itermRun())
    await doStop(ctx, wt, 'worker')
    expect(mockExeca).not.toHaveBeenCalled()
    const s = await readState('foo')
    expect(s.sets['2'].run!.services).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/cli/stop.flow.test.ts`
Expected: FAIL（`doStop` 不存在）

- [ ] **Step 3: 实现 `src/cli/commands/stop.ts`**

```ts
import type { Command } from 'commander'
import type { Ctx } from '../../core/types.js'
import { readState, withState } from '../../state/store.js'
import { findSetByWorktree } from '../../core/deallocator.js'
import { stopRun } from '../../launch/stop.js'
import { BkError, Codes } from '../../core/errors.js'
import { loadCtx, runCommand } from '../context.js'
import { info, success } from '../output.js'

export async function doStop(ctx: Ctx, worktreeDir: string, service?: string): Promise<void> {
  const project = ctx.config.project_name
  const state = await readState(project)
  const n = findSetByWorktree(state, worktreeDir)
  if (!n) throw new BkError(Codes.NOT_IN_WORKTREE,
    '当前 worktree 未分配资源', { remediation: '先运行 `bk allocate`' })
  const run = state.sets[n].run
  if (!run) { info('当前没有由 bk 启动的服务在运行'); return }
  if (service && !run.services.some(s => s.name === service)) {
    info(`服务 ${service} 未在运行`); return
  }
  const remaining = await stopRun(run, service)
  await withState(project, s => {
    if (remaining) s.sets[n].run = remaining
    else delete s.sets[n].run
  })
  success(service ? `已停止 ${service}` : '已停止当前 worktree 的服务')
}

export function registerStop(program: Command) {
  program.command('stop [service]').description('停止当前 worktree 的服务（不带参数 = 全部）')
    .action((service: string | undefined) =>
      runCommand(async () => { await doStop(loadCtx(), process.cwd(), service) }))
}
```

- [ ] **Step 4: 注册命令（`src/cli/index.ts`）**

在 import 区（`registerStart` 那行附近）加：

```ts
import { registerStop } from './commands/stop.js'
```

在 `registerStart(program)` 行下方加：

```ts
registerStop(program)
```

- [ ] **Step 5: 跑测试确认通过 + 全量 + 类型检查**

Run: `npx vitest run tests/cli/stop.flow.test.ts && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/cli/commands/stop.ts src/cli/index.ts tests/cli/stop.flow.test.ts
git commit -m "feat(stop): bk stop [service] 停止当前 worktree 服务"
```

---

## Task 6: bk restart 命令

**Files:**
- Create: `src/cli/commands/restart.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/restart.flow.test.ts`（新）

**Interfaces:**
- Consumes: `stopRun`（Task 3）、`mergeRun`（Task 1）、`buildLaunchSpecs`/`runLaunch`/`selectStrategy`（Task 2）、`findSetByWorktree`、`readState`/`withState`。
- Produces: `doRestart(ctx: Ctx, worktreeDir: string, service?: string, env?: NodeJS.ProcessEnv): Promise<void>`；`registerRestart(program)`。

行为约定：
- 有 run 且目标在运行 → 先 `stopRun`（写回剩余/清空），再用**原 run 的 strategy**重新 `runLaunch`；无 run → 退化为 start（用 `selectStrategy(env)` 探测）。
- 重启用 `mergeRun` 把新句柄并回 run 记录（单服务重启保留其余服务）。

- [ ] **Step 1: 写失败测试** — `tests/cli/restart.flow.test.ts`

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { withState, readState } from '../../src/state/store.js'
import { doRestart } from '../../src/cli/commands/restart.js'
import type { Ctx, SetRecord } from '../../src/core/types.js'

const mockExeca = vi.mocked(execa)
let home: string
const wt = '/wt'
const ctx: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
  services: [{ name: 'backend', type: 'django', port_base: 10000 },
             { name: 'frontend', type: 'vite', port_base: 10100 }] } }

const seed = (run?: SetRecord['run']) => withState('foo', s => {
  s.sets['2'] = { status: 'allocated', owner: { worktree: wt, branch: 'x' },
    resources: { backend: { port: 10002 }, frontend: { port: 10102 } }, created_at: 't', run }
})
const itermRun = (): SetRecord['run'] => ({ strategy: 'iterm', startedAt: 't0',
  services: [{ name: 'backend', itermSessionId: 'A' }, { name: 'frontend', itermSessionId: 'B' }] })

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home
  mockExeca.mockReset() })
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.BK_HOME })

describe('doRestart', () => {
  it('未分配 worktree → 抛 NOT_IN_WORKTREE', async () => {
    mockExeca.mockResolvedValue({ stdout: '' } as never)
    await expect(doRestart(ctx, '/nope')).rejects.toMatchObject({ code: 'NOT_IN_WORKTREE' })
  })

  it('停全部 + 重启 → close 旧 session 后用新 session id 重写整条 run', async () => {
    await seed(itermRun())
    // 前两次调用是 close（停全部），第三次是 osascript 启动并返回新 session id
    mockExeca
      .mockResolvedValueOnce({ stdout: '' } as never)
      .mockResolvedValueOnce({ stdout: '' } as never)
      .mockResolvedValueOnce({ stdout: 'NB, NF' } as never)
    await doRestart(ctx, wt)
    const s = await readState('foo')
    expect(s.sets['2'].run).toMatchObject({ strategy: 'iterm',
      services: [{ name: 'backend', itermSessionId: 'NB' }, { name: 'frontend', itermSessionId: 'NF' }] })
  })

  it('无 run → 退化为 start，用 force 之外的 env 探测；写入新 run', async () => {
    await seed(undefined)
    mockExeca.mockResolvedValue({ stdout: 'NB, NF' } as never)
    await doRestart(ctx, wt, undefined, { __platform: 'darwin', TERM_PROGRAM: 'iTerm.app' } as NodeJS.ProcessEnv)
    const s = await readState('foo')
    expect(s.sets['2'].run!.strategy).toBe('iterm')
    expect(s.sets['2'].run!.services).toHaveLength(2)
  })

  it('单服务重启 → 只 close 该 session、新句柄并回、其余保留', async () => {
    await seed(itermRun())
    mockExeca
      .mockResolvedValueOnce({ stdout: '' } as never)   // close backend
      .mockResolvedValueOnce({ stdout: 'NB' } as never)  // 重启 backend（单 service → 单 id）
    await doRestart(ctx, wt, 'backend', { __platform: 'darwin', TERM_PROGRAM: 'iTerm.app' } as NodeJS.ProcessEnv)
    const s = await readState('foo')
    const byName = Object.fromEntries(s.sets['2'].run!.services.map(x => [x.name, x.itermSessionId]))
    expect(byName).toEqual({ frontend: 'B', backend: 'NB' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/cli/restart.flow.test.ts`
Expected: FAIL（`doRestart` 不存在）

- [ ] **Step 3: 实现 `src/cli/commands/restart.ts`**

```ts
import type { Command } from 'commander'
import type { Ctx } from '../../core/types.js'
import { readState, withState } from '../../state/store.js'
import { findSetByWorktree } from '../../core/deallocator.js'
import { buildLaunchSpecs, selectStrategy, runLaunch } from '../../launch/index.js'
import { stopRun } from '../../launch/stop.js'
import { mergeRun } from '../../core/run.js'
import { BkError, Codes } from '../../core/errors.js'
import { loadCtx, runCommand } from '../context.js'
import { success } from '../output.js'

export async function doRestart(
  ctx: Ctx, worktreeDir: string, service?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const project = ctx.config.project_name
  const state = await readState(project)
  const n = findSetByWorktree(state, worktreeDir)
  if (!n) throw new BkError(Codes.NOT_IN_WORKTREE,
    '当前 worktree 未分配资源', { remediation: '先运行 `bk allocate`' })
  const run = state.sets[n].run

  // 1. 停（仅当有 run 且目标确实在运行）
  const willStop = run && (!service || run.services.some(s => s.name === service))
  if (run && willStop) {
    const remaining = await stopRun(run, service)
    await withState(project, s => {
      if (remaining) s.sets[n].run = remaining
      else delete s.sets[n].run
    })
  }

  // 2. 重读配置后启动；沿用原 run 的 strategy，无 run 则探测
  const specs = buildLaunchSpecs(ctx, state.sets[n], worktreeDir, service)
  const strategy = run?.strategy ?? selectStrategy(env)
  const launched = await runLaunch(specs, strategy)

  // 3. 把新句柄并回 run 记录
  await withState(project, s => {
    const merged = mergeRun(s.sets[n].run, launched, new Date().toISOString())
    if (merged) s.sets[n].run = merged
    else delete s.sets[n].run
  })
  success(service ? `已重启 ${service}` : '已重启当前 worktree 的服务')
}

export function registerRestart(program: Command) {
  program.command('restart [service]').description('重启当前 worktree 的服务（= stop + start，重读配置）')
    .action((service: string | undefined) =>
      runCommand(async () => { await doRestart(loadCtx(), process.cwd(), service) }))
}
```

- [ ] **Step 4: 注册命令（`src/cli/index.ts`）**

在 import 区加：

```ts
import { registerRestart } from './commands/restart.js'
```

在 `registerStop(program)` 行下方加：

```ts
registerRestart(program)
```

- [ ] **Step 5: 跑测试确认通过 + 全量 + 类型检查**

Run: `npx vitest run tests/cli/restart.flow.test.ts && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/cli/commands/restart.ts src/cli/index.ts tests/cli/restart.flow.test.ts
git commit -m "feat(restart): bk restart [service] = stop + 重读配置 start"
```

---

## Task 7: 文档（README + CHANGELOG）

**Files:**
- Modify: `README.md:206-212`（启动服务小节）
- Modify: `CHANGELOG.md`

**Interfaces:** 无代码接口；纯文档。

- [ ] **Step 1: 改 README**

把 `README.md` 第 212 行那句「**bk 不监管进程**——停止/重启/看输出都交给终端。」所在段落之后，新增小节（紧接「启动服务」小节，在「### 观测」之前）：

````markdown
### 停止 / 重启服务

```bash
bk stop    [service]   # 停止当前 worktree 的服务（不带参数 = 全部）
bk restart [service]   # 重启 = 停止 + 重读 bk_config.yml 后重新启动
```

`bk start` 成功派发后会记住自己启动了什么（iTerm 记每个 pane 的 session id，tmux 记 session 与 pane id），`stop` / `restart` 据此操作：

- **iTerm**：关闭对应 pane 同时终止其中进程（含无端口 worker），不残留空窗口。
- **tmux**：停全部 = `kill-session`，停单个 = `kill-pane`。
- 句柄已失效（你手动关了窗口）→ 跳过、不报错（幂等）。
- `restart` 没在跑时直接当 `start`；`start` 时若已有服务在运行会报错，提示改用 `restart`。
- 用 `--print` 自己手动跑的服务 bk 没有句柄，不归 `stop` / `restart` 管。

> **iTerm 注意**：若你在 iTerm 偏好里开启了「关闭仍在运行任务的会话需确认」，`stop` 关闭 pane 时可能弹确认框。可在 iTerm → Settings → Profiles → Session（或 General）关掉运行中会话的关闭确认，让 `stop` 静默生效。
````

并把上一段结尾的「**bk 不监管进程**——停止/重启/看输出都交给终端。」改为：

```markdown
**bk 仍不守护进程**（不做崩溃自动重启、不做健康检查），但它记住自己启动了什么，因此可用 `bk stop` / `bk restart` 停止或重启（见下）。
```

- [ ] **Step 2: 改 CHANGELOG**

在 `CHANGELOG.md` 的 `# Changelog` 标题与 `## [0.0.8]` 之间插入：

```markdown
## [Unreleased]

### Added

- `bk stop [service]` 与 `bk restart [service]`：停止 / 重启「由 `bk start` 启动」的当前 worktree 服务。`bk start` 成功后记录运行句柄（iTerm 存 session id、tmux 存 session 与 pane id）；`stop` 关闭 iTerm pane（含无端口 worker）或 `kill-session`/`kill-pane`，`restart` = 停止 + 重读配置后重启。句柄失效时幂等跳过；`bk start` 已在运行时报错提示改用 `restart`。

```

- [ ] **Step 3: 全量测试 + 类型检查（确认未误伤）**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: bk stop/restart 文档与 CHANGELOG"
```

---

## Self-Review

**Spec coverage（逐节核对）：**
- §1 命令与语义 → Task 5/6（`stop [service]` / `restart [service]`），`restart` 无 run 当 start（Task 6 Step 3）、`start` 已运行护栏（Task 4）。✅
- §2 运行记录数据模型 → Task 1（类型）、Task 4（start 写）、Task 5（stop 清/留）、Task 6（restart merge）。✅
- §3 iTerm 机制 → Task 2（捕获 unique id）、Task 3（close）。✅
- §4 tmux 机制 → Task 2（捕获 pane id）、Task 3（kill-session/kill-pane）。✅
- §5 restart → Task 6。✅
- §6 错误处理边界表 → NOT_IN_WORKTREE（Task 4/5/6）、无 run（Task 5）、服务不在 run（Task 5）、restart 无 run（Task 6）、句柄失效（Task 3）、start 已运行（Task 4）、print 不记录（Task 2/4）。✅
- §7 文件改动清单 → 各 Task 文件覆盖；新增 `src/cli/commands/stop.ts`、`restart.ts`，`src/launch/stop.ts`，`src/core/run.ts`。✅
- 测试策略 → 纯函数（mergeRun、buildItermScript）、mock execa（runTmux/stopRun/各 flow）、容错（Task 3 Step 1 末例）。✅
- 非目标（YAGNI）→ 不做守护/健康检查（未实现）；不管 print/手动启动（Task 2/4）；不跨 worktree（doX 始终按 worktreeDir）；不抓日志。✅

**Placeholder 扫描：** 无 TBD/TODO；每个 code step 均含完整代码。✅

**类型一致性：**
- `RunService` / `RunHandle` / `RunRecord`（Task 1）→ `LaunchResult = RunHandle | null`（Task 2）→ `mergeRun(existing, launched: RunHandle|null, …)`（Task 1 与 Task 6 一致）。✅
- `runTmux(): Promise<{ session, paneIds }>`（Task 2 定义与使用一致）；`runIterm(): Promise<string[]>`；`stopRun(run, only?): Promise<RunRecord|null>`（Task 3 定义、Task 5/6 使用一致）。✅
- `doStart(ctx, wt, service?, force?, env?)` / `doStop(ctx, wt, service?)` / `doRestart(ctx, wt, service?, env?)` 签名在定义与测试中一致。✅
- `Codes.SERVICE_RUNNING`（Task 4 定义并使用）。✅

**已知限制（写在非目标/文档之外的提醒）：** 单服务 `restart` 会把该服务重新派发到一个**新的独立窗口/会话**（不回到原共享窗口）；tmux 下若被重启的恰是给 session 命名的首个服务且其余服务仍在原 session 运行，`new-session` 可能因同名冲突报错——此时改用整组 `restart` 或 `stop` 后 `start`。此为窄边界，不在本期处理。
