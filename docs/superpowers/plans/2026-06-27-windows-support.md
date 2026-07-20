# Windows 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `bk` 在 Windows 上真正可用——`allocate` + `start` + `stop` + `restart` 全部跑通。

**Architecture:** 改动集中在 `src/launch/` 启动层：新增 `wt`（Windows Terminal 平铺 pane）与 `win`（独立 PowerShell 窗口）两种策略，外加 `hooks/postAllocate.ts` 的 shell 执行修复与 `core/types.ts` 句柄扩展。资源层、配置层、状态层不动。

**Tech Stack:** TypeScript（ESM，import 带 `.js` 后缀）、Node ≥20、execa v9、Node `child_process` spawn、vitest、Windows Terminal `wt.exe`、PowerShell（`pwsh` 优先，`powershell` 5.1 兜底）、`taskkill` / `Get-NetTCPConnection`。

## Global Constraints

- Node ≥ 20；项目为 ESM（`"type":"module"`），**所有相对 import 必须带 `.js` 后缀**。
- 代码注释与用户可见字符串用中文，匹配现有风格。
- 平台来源沿用既有约定：`env.__platform ?? process.platform`（测试用 `__platform` 注入）。
- execa v9 API：`execa(file, args?, opts?)`；shell 模式为 `execa(commandString, { shell: true })`。
- 测试用 `vi.mock('execa', () => ({ execa: vi.fn() }))` mock execa，断言调用参数（见现有 `tests/launch/*.test.ts`）。
- 版本号从 `0.0.9` bump 到 `0.0.10`。
- 不做进程守护 / 崩溃重启 / 健康检查（与 `bk start` 现有职责边界一致）。
- 每个任务结束都 `npm run typecheck` 通过、相关测试绿、然后 commit。

## 与 spec 的一处偏差（已确认）

spec §2 写「wt 复用 `planGrid` 决定分屏几何」。实现时发现 **Windows Terminal CLI 无法按 pane id 定位任意 pane 去 split**（split-pane 只作用于当前聚焦 pane，且无稳定的 pane 寻址）。因此 wt 改用 `new-tab` + 重复 `split-pane`（默认 auto 方向，wt 自动平铺），不复用 `planGrid`。效果仍是「一个窗口、平铺多 pane」，符合 spec 意图。

---

### Task 1: 扩展句柄类型与 `LaunchSpec.port`

为后续所有 Windows 句柄/兜底逻辑打地基：策略联合类型加 `wt`/`win`，`RunService` 加 `pid?`/`port?`，并让 `buildLaunchSpecs` 把端口带进 `LaunchSpec`（stop 兜底要用）。

**Files:**
- Modify: `src/core/types.ts:49-58`
- Modify: `src/launch/index.ts:9`（`LaunchSpec` 接口）、`src/launch/index.ts:13-32`（`buildLaunchSpecs`）
- Test: `tests/launch/buildSpecs.test.ts`（新建）

**Interfaces:**
- Consumes: 无（基础任务）。
- Produces:
  - `interface LaunchSpec { name: string; command: string; cwd: string; port?: number }`
  - `RunService` 增 `pid?: number`、`port?: number`
  - `RunHandle.strategy: 'tmux' | 'iterm' | 'wt' | 'win'`

- [ ] **Step 1: 写失败测试**

新建 `tests/launch/buildSpecs.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { buildLaunchSpecs } from '../../src/launch/index.js'
import type { Ctx, SetRecord } from '../../src/core/types.js'

const ctx: Ctx = { projectRoot: '/x', config: { project_name: 'foo', infra: {},
  services: [
    { name: 'backend', type: 'django', port_base: 10000 },
    { name: 'worker', type: 'arq', app: 'app.worker' },
  ] } }

const set: SetRecord = { status: 'allocated', owner: { worktree: '/wt', branch: 'x' },
  resources: { backend: { port: 10002 } }, created_at: 't' }

describe('buildLaunchSpecs port 透传', () => {
  it('有端口的 service：spec.port = 已分配端口', () => {
    const specs = buildLaunchSpecs(ctx, set, '/wt')
    expect(specs.find(s => s.name === 'backend')!.port).toBe(10002)
  })
  it('无端口的 worker：spec.port = undefined', () => {
    const specs = buildLaunchSpecs(ctx, set, '/wt')
    expect(specs.find(s => s.name === 'worker')!.port).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/launch/buildSpecs.test.ts`
Expected: FAIL（`spec.port` 为 `undefined`，第一个断言挂——因为现在 `buildLaunchSpecs` 不返回 `port`）。

- [ ] **Step 3: 改类型 + buildLaunchSpecs**

`src/core/types.ts` 把 `RunService` 与 `RunHandle` 改成：

```typescript
export interface RunService {
  name: string
  itermSessionId?: string   // strategy === 'iterm'：iTerm session 的 unique id
  tmuxPaneId?: string       // strategy === 'tmux'：tmux pane id（如 %3），支持单服务停
  pid?: number              // strategy === 'wt' | 'win'：宿主进程 PID，stop 用 taskkill 杀树
  port?: number             // strategy === 'wt' | 'win'：该服务端口，pid 缺失时按端口兜底找进程
}
export interface RunHandle {
  strategy: 'tmux' | 'iterm' | 'wt' | 'win'   // 'print' 不记录（bk 无句柄）
  tmuxSession?: string         // strategy === 'tmux'：tmux session 名
  services: RunService[]
}
```

`src/launch/index.ts` 把 `LaunchSpec` 改成带 `port`，并在 `buildLaunchSpecs` 的 `return` 带上 `port`：

```typescript
export interface LaunchSpec { name: string; command: string; cwd: string; port?: number }
```

`buildLaunchSpecs` 末尾的 return（原 line 30）改为：

```typescript
      return { name: s.name, command, cwd: join(worktreeDir, s.dir ?? '.'), port }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/launch/buildSpecs.test.ts`
Expected: PASS（2 passed）。

- [ ] **Step 5: typecheck + commit**

```bash
cd "C:/Users/Administrator/Workspace/bookkeeper"
npm run typecheck
git add src/core/types.ts src/launch/index.ts tests/launch/buildSpecs.test.ts
git commit -m "feat(launch): 句柄类型加 wt/win 与 pid/port，LaunchSpec 透传 port"
```

---

### Task 2: `selectStrategy` 增加 Windows 分支

把签名从 `(env, force?)` 改为 `(env, { force?, hasWt? })`，并加 win32 分支：有 wt 用 `'wt'`、没有用 `'win'`。`hasWt` 由调用方探测后传入（保持本函数纯、可测）。

**Files:**
- Modify: `src/launch/index.ts:34-42`（`selectStrategy`）
- Modify: `src/cli/commands/start.ts:22`、`src/cli/commands/restart.ts:35`（更新调用方以编译通过；真实 `hasWt` 注入在 Task 7）
- Test: `tests/launch/select.test.ts`（重写为新签名 + 新增 win 用例）

**Interfaces:**
- Consumes: `Strategy = 'tmux' | 'iterm' | 'wt' | 'win' | 'print'`（本任务把 `'wt' | 'win'` 加入该联合）。
- Produces: `selectStrategy(env, opts?: { force?: Strategy; hasWt?: boolean }): Strategy`

- [ ] **Step 1: 写失败测试（重写 select.test.ts）**

把 `tests/launch/select.test.ts` 整文件替换为：

```typescript
import { describe, it, expect } from 'vitest'
import { selectStrategy } from '../../src/launch/index.js'

describe('selectStrategy', () => {
  it('force 优先', () => expect(selectStrategy({}, { force: 'print' })).toBe('print'))
  it('TMUX 环境 → tmux', () => expect(selectStrategy({ TMUX: '/tmp/x' })).toBe('tmux'))
  it('macOS iTerm → iterm', () =>
    expect(selectStrategy({ __platform: 'darwin', TERM_PROGRAM: 'iTerm.app' })).toBe('iterm'))
  it('Windows 有 wt → wt', () =>
    expect(selectStrategy({ __platform: 'win32' }, { hasWt: true })).toBe('wt'))
  it('Windows 无 wt → win', () =>
    expect(selectStrategy({ __platform: 'win32' }, { hasWt: false })).toBe('win'))
  it('其他 → print', () => expect(selectStrategy({ __platform: 'linux' })).toBe('print'))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/launch/select.test.ts`
Expected: FAIL（新签名 `{ force: 'print' }` 与 win 用例都挂——当前实现把第二参当作 `force` 字符串）。

- [ ] **Step 3: 改 selectStrategy + 更新调用方**

`src/launch/index.ts` 把 `Strategy` 与 `selectStrategy` 改为：

```typescript
export type Strategy = 'tmux' | 'iterm' | 'wt' | 'win' | 'print'

export function selectStrategy(
  env: NodeJS.ProcessEnv & { __platform?: string },
  opts: { force?: Strategy; hasWt?: boolean } = {},
): Strategy {
  if (opts.force) return opts.force
  if (env.TMUX) return 'tmux'
  const platform = env.__platform ?? process.platform
  if (platform === 'darwin' && env.TERM_PROGRAM === 'iTerm.app') return 'iterm'
  if (platform === 'win32') return opts.hasWt ? 'wt' : 'win'
  return 'print'
}
```

`src/cli/commands/start.ts` 第 22 行：

```typescript
  const launched = await runLaunch(specs, selectStrategy(env, { force }))
```

`src/cli/commands/restart.ts` 第 35 行：

```typescript
  const strategy = run?.strategy ?? selectStrategy(env)
```
（restart 无 force；保持原样即可——`selectStrategy(env)` 现在合法。Task 7 再注入 `hasWt`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/launch/select.test.ts`
Expected: PASS（6 passed）。

- [ ] **Step 5: typecheck + commit**

```bash
cd "C:/Users/Administrator/Workspace/bookkeeper"
npm run typecheck
git add src/launch/index.ts src/cli/commands/start.ts src/cli/commands/restart.ts tests/launch/select.test.ts
git commit -m "feat(launch): selectStrategy 加 win32 分支（wt / win）"
```

---

### Task 3: 平台探测 helper（`hasWindowsTerminal` / `resolvePsHost`）

两个薄运行时探测：`wt.exe` 是否在 PATH，以及宿主 shell 选 `pwsh` 还是 `powershell`。非 win32 时 `hasWindowsTerminal` 直接返回 false（不跑 execa）。

**Files:**
- Create: `src/launch/platform.ts`
- Test: `tests/launch/platform.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `hasWindowsTerminal(env?: NodeJS.ProcessEnv & { __platform?: string }): Promise<boolean>`
  - `resolvePsHost(): Promise<'pwsh' | 'powershell'>`

- [ ] **Step 1: 写失败测试**

新建 `tests/launch/platform.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'
import { hasWindowsTerminal, resolvePsHost } from '../../src/launch/platform.js'

const mockExeca = vi.mocked(execa)
beforeEach(() => { mockExeca.mockReset() })

describe('hasWindowsTerminal', () => {
  it('非 win32 → false，且不调用 execa', async () => {
    expect(await hasWindowsTerminal({ __platform: 'darwin' })).toBe(false)
    expect(mockExeca).not.toHaveBeenCalled()
  })
  it('win32 且 where wt 成功 → true', async () => {
    mockExeca.mockResolvedValue({ stdout: 'C:\\wt.exe' } as never)
    expect(await hasWindowsTerminal({ __platform: 'win32' })).toBe(true)
    expect(mockExeca).toHaveBeenCalledWith('where', ['wt'])
  })
  it('win32 但 where wt 抛错 → false', async () => {
    mockExeca.mockRejectedValue(new Error('not found'))
    expect(await hasWindowsTerminal({ __platform: 'win32' })).toBe(false)
  })
})

describe('resolvePsHost', () => {
  it('where pwsh 成功 → pwsh', async () => {
    mockExeca.mockResolvedValue({ stdout: 'C:\\pwsh.exe' } as never)
    expect(await resolvePsHost()).toBe('pwsh')
  })
  it('where pwsh 抛错 → powershell', async () => {
    mockExeca.mockRejectedValue(new Error('not found'))
    expect(await resolvePsHost()).toBe('powershell')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/launch/platform.test.ts`
Expected: FAIL（模块不存在 / 函数未定义）。

- [ ] **Step 3: 实现 platform.ts**

新建 `src/launch/platform.ts`：

```typescript
import { execa } from 'execa'

// wt.exe 是否在 PATH —— 仅 win32 才探测，其余平台直接 false。
export async function hasWindowsTerminal(
  env: NodeJS.ProcessEnv & { __platform?: string } = process.env,
): Promise<boolean> {
  const platform = env.__platform ?? process.platform
  if (platform !== 'win32') return false
  try { await execa('where', ['wt']); return true } catch { return false }
}

// 宿主 shell：优先 PowerShell 7（pwsh，支持 &&），否则回退内置 powershell 5.1。
export async function resolvePsHost(): Promise<'pwsh' | 'powershell'> {
  try { await execa('where', ['pwsh']); return 'pwsh' } catch { return 'powershell' }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/launch/platform.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: typecheck + commit**

```bash
cd "C:/Users/Administrator/Workspace/bookkeeper"
npm run typecheck
git add src/launch/platform.ts tests/launch/platform.test.ts
git commit -m "feat(launch): 平台探测 helper（hasWindowsTerminal / resolvePsHost）"
```

---

### Task 4: `wt` 启动器

构建单条 `wt` 调用（`new-tab` + 重复 `split-pane`，auto 平铺），每个 pane 在 PowerShell 里自报 `$PID` 到 pidfile；启动后回读 pidfile 得到各服务 PID（`wt` 会吞掉子进程 PID，故用 pidfile）。把纯构建逻辑（`buildWtArgs`、`pidFileFor`）与跑/回读（`runWt`）分开，便于测纯函数。

**Files:**
- Create: `src/launch/wt.ts`
- Test: `tests/launch/wt.test.ts`

**Interfaces:**
- Consumes: `LaunchSpec`（含 `port?`），`'pwsh' | 'powershell'`。
- Produces:
  - `pidFileFor(spec: LaunchSpec): string` —— 该 spec 的 pidfile 绝对路径（`tmpdir()/bk-run/<sanitized-cwd>__<name>.pid`）。
  - `buildWtArgs(specs: LaunchSpec[], psHost: string, pidFiles: string[]): string[]` —— 传给 `execa('wt', args)` 的 argv。
  - `runWt(specs: LaunchSpec[], psHost: 'pwsh' | 'powershell'): Promise<{ pids: (number | undefined)[] }>`

- [ ] **Step 1: 写失败测试**

新建 `tests/launch/wt.test.ts`（只测纯构建函数，避免真起进程）：

```typescript
import { describe, it, expect } from 'vitest'
import { buildWtArgs, pidFileFor } from '../../src/launch/wt.js'
import type { LaunchSpec } from '../../src/launch/index.js'

const specs: LaunchSpec[] = [
  { name: 'backend', command: 'uv run x', cwd: 'C:\\wt\\backend', port: 10002 },
  { name: 'frontend', command: 'npm run dev', cwd: 'C:\\wt\\frontend', port: 10102 },
]
const pf = specs.map(pidFileFor)

describe('pidFileFor', () => {
  it('同 cwd 不同 name → 不同 pidfile', () => {
    expect(pidFileFor(specs[0])).not.toBe(pidFileFor(specs[1]))
  })
  it('以 .pid 结尾', () => expect(pidFileFor(specs[0]).endsWith('.pid')).toBe(true))
})

describe('buildWtArgs', () => {
  const args = buildWtArgs(specs, 'pwsh', pf)
  it('首个子命令是 new-tab，其后用 split-pane', () => {
    expect(args[0]).toBe('new-tab')
    expect(args).toContain('split-pane')
  })
  it('每个 pane 带 -d cwd', () => {
    expect(args).toContain('C:\\wt\\backend')
    expect(args).toContain('C:\\wt\\frontend')
  })
  it('用 ; 分隔 wt 子命令', () => {
    expect(args).toContain(';')
  })
  it('pane 命令在 PowerShell 里先写 $PID 到 pidfile 再跑原命令', () => {
    const joined = args.join('')
    expect(joined).toContain(`$PID | Out-File -Encoding ascii '${pf[0]}'; uv run x`)
    expect(joined).toContain(`$PID | Out-File -Encoding ascii '${pf[1]}'; npm run dev`)
  })
  it('宿主可执行用传入的 psHost', () => {
    expect(args).toContain('pwsh')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/launch/wt.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 wt.ts**

新建 `src/launch/wt.ts`：

```typescript
import { execa } from 'execa'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LaunchSpec } from './index.js'

const PID_DIR = join(tmpdir(), 'bk-run')

// 用 cwd + name 唯一定位 pidfile（每个 worktree 的 cwd 互不相同）。
export function pidFileFor(spec: LaunchSpec): string {
  const key = `${spec.cwd}__${spec.name}`.replace(/[^A-Za-z0-9]+/g, '_')
  return join(PID_DIR, `${key}.pid`)
}

// pane 命令：PowerShell 先把自身 $PID 写进 pidfile，再跑原命令。
function paneScript(command: string, pidFile: string): string {
  return `$PID | Out-File -Encoding ascii '${pidFile}'; ${command}`
}

// 构建 `wt` 的 argv：new-tab + 重复 split-pane（auto 平铺），子命令以 ';' 分隔。
export function buildWtArgs(specs: LaunchSpec[], psHost: string, pidFiles: string[]): string[] {
  const args: string[] = []
  specs.forEach((s, i) => {
    if (i > 0) args.push(';', 'split-pane')
    else args.push('new-tab')
    args.push('-d', s.cwd, psHost, '-NoExit', '-Command', paneScript(s.command, pidFiles[i]))
  })
  return args
}

// 轮询读取 pidfile（最多约 3s），拿不到返回 undefined。
async function readPid(pidFile: string): Promise<number | undefined> {
  for (let i = 0; i < 30; i++) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (!Number.isNaN(pid)) return pid
    } catch { /* 还没写出来 */ }
    await new Promise(r => setTimeout(r, 100))
  }
  return undefined
}

export async function runWt(
  specs: LaunchSpec[], psHost: 'pwsh' | 'powershell',
): Promise<{ pids: (number | undefined)[] }> {
  if (!specs.length) return { pids: [] }
  const pidFiles = specs.map(pidFileFor)
  mkdirSync(dirname(pidFiles[0]), { recursive: true })
  for (const f of pidFiles) { try { rmSync(f) } catch { /* 无旧文件 */ } }
  await execa('wt', buildWtArgs(specs, psHost, pidFiles))
  const pids = await Promise.all(pidFiles.map(readPid))
  return { pids }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/launch/wt.test.ts`
Expected: PASS（全部 passed）。

- [ ] **Step 5: typecheck + commit**

```bash
cd "C:/Users/Administrator/Workspace/bookkeeper"
npm run typecheck
git add src/launch/wt.ts tests/launch/wt.test.ts
git commit -m "feat(launch): wt 启动器（平铺 pane + pidfile 自报 PID）"
```

---

### Task 5: `win` 启动器（独立 PowerShell 窗口）

每个服务用 Node `spawn` 起一个 detached 控制台窗口，`spawn` 直接返回 `.pid`——无需 pidfile。纯构建（`buildWinSpawn`）与跑（`runWin`）分开。

**Files:**
- Create: `src/launch/win.ts`
- Test: `tests/launch/win.test.ts`

**Interfaces:**
- Consumes: `LaunchSpec`，`'pwsh' | 'powershell'`。
- Produces:
  - `buildWinSpawn(spec: LaunchSpec, psHost: string): { file: string; args: string[]; opts: { cwd: string; detached: true; stdio: 'ignore'; windowsHide: false } }`
  - `runWin(specs: LaunchSpec[], psHost: 'pwsh' | 'powershell'): Promise<{ pids: (number | undefined)[] }>`

- [ ] **Step 1: 写失败测试**

新建 `tests/launch/win.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
import { spawn } from 'node:child_process'
import { buildWinSpawn, runWin } from '../../src/launch/win.js'
import type { LaunchSpec } from '../../src/launch/index.js'

const mockSpawn = vi.mocked(spawn)
const specs: LaunchSpec[] = [
  { name: 'backend', command: 'uv run x', cwd: 'C:\\wt\\backend', port: 10002 },
  { name: 'frontend', command: 'npm run dev', cwd: 'C:\\wt\\frontend', port: 10102 },
]

describe('buildWinSpawn', () => {
  const r = buildWinSpawn(specs[0], 'powershell')
  it('file = psHost', () => expect(r.file).toBe('powershell'))
  it('args 用 -NoExit -Command 跑原命令', () =>
    expect(r.args).toEqual(['-NoExit', '-Command', 'uv run x']))
  it('opts：cwd / detached / stdio ignore', () => {
    expect(r.opts.cwd).toBe('C:\\wt\\backend')
    expect(r.opts.detached).toBe(true)
    expect(r.opts.stdio).toBe('ignore')
  })
})

describe('runWin', () => {
  beforeEach(() => {
    mockSpawn.mockReset()
    let pid = 1000
    mockSpawn.mockImplementation((() => ({ pid: ++pid, unref() {} })) as never)
  })
  it('每个 service spawn 一次，按序返回 pid', async () => {
    const { pids } = await runWin(specs, 'powershell')
    expect(mockSpawn).toHaveBeenCalledTimes(2)
    expect(pids).toEqual([1001, 1002])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/launch/win.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 win.ts**

新建 `src/launch/win.ts`：

```typescript
import { spawn } from 'node:child_process'
import type { LaunchSpec } from './index.js'

// 单个服务的 spawn 参数：在自己的 detached 控制台窗口里用 PowerShell 跑命令。
export function buildWinSpawn(spec: LaunchSpec, psHost: string): {
  file: string; args: string[]
  opts: { cwd: string; detached: true; stdio: 'ignore'; windowsHide: false }
} {
  return {
    file: psHost,
    args: ['-NoExit', '-Command', spec.command],
    opts: { cwd: spec.cwd, detached: true, stdio: 'ignore', windowsHide: false },
  }
}

export async function runWin(
  specs: LaunchSpec[], psHost: 'pwsh' | 'powershell',
): Promise<{ pids: (number | undefined)[] }> {
  const pids = specs.map(s => {
    const { file, args, opts } = buildWinSpawn(s, psHost)
    const child = spawn(file, args, opts)
    child.unref()
    return child.pid
  })
  return { pids }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/launch/win.test.ts`
Expected: PASS（全部 passed）。

- [ ] **Step 5: typecheck + commit**

```bash
cd "C:/Users/Administrator/Workspace/bookkeeper"
npm run typecheck
git add src/launch/win.ts tests/launch/win.test.ts
git commit -m "feat(launch): win 启动器（独立 PowerShell 窗口，spawn 直取 PID）"
```

---

### Task 6: `runLaunch` 接入 wt / win

`runLaunch` 增加 `'wt'` / `'win'` 分支：解析宿主 shell、调用对应启动器、把 `pid` 与 `spec.port` 写进 `RunService`。

**Files:**
- Modify: `src/launch/index.ts:44-54`（`runLaunch`）+ 顶部 import
- Test: `tests/launch/runLaunch.test.ts`（新建）

**Interfaces:**
- Consumes: `runWt`（Task 4）、`runWin`（Task 5）、`resolvePsHost`（Task 3）。
- Produces: `runLaunch(specs, strategy)` 对 `'wt'`/`'win'` 返回 `{ strategy, services: [{ name, pid, port }, ...] }`。

- [ ] **Step 1: 写失败测试**

新建 `tests/launch/runLaunch.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/launch/platform.js', () => ({ resolvePsHost: vi.fn() }))
vi.mock('../../src/launch/wt.js', () => ({ runWt: vi.fn() }))
vi.mock('../../src/launch/win.js', () => ({ runWin: vi.fn() }))
import { resolvePsHost } from '../../src/launch/platform.js'
import { runWt } from '../../src/launch/wt.js'
import { runWin } from '../../src/launch/win.js'
import { runLaunch, type LaunchSpec } from '../../src/launch/index.js'

const specs: LaunchSpec[] = [
  { name: 'backend', command: 'a', cwd: 'C:\\wt\\b', port: 10002 },
  { name: 'worker', command: 'c', cwd: 'C:\\wt\\b' },
]

beforeEach(() => {
  vi.mocked(resolvePsHost).mockResolvedValue('pwsh')
  vi.mocked(runWt).mockResolvedValue({ pids: [111, 222] })
  vi.mocked(runWin).mockResolvedValue({ pids: [333, 444] })
})

describe('runLaunch wt / win', () => {
  it('wt：句柄含 strategy=wt、每服务 pid 与 port', async () => {
    const r = await runLaunch(specs, 'wt')
    expect(r).toEqual({ strategy: 'wt', services: [
      { name: 'backend', pid: 111, port: 10002 },
      { name: 'worker', pid: 222, port: undefined },
    ] })
  })
  it('win：句柄含 strategy=win、每服务 pid 与 port', async () => {
    const r = await runLaunch(specs, 'win')
    expect(r).toEqual({ strategy: 'win', services: [
      { name: 'backend', pid: 333, port: 10002 },
      { name: 'worker', pid: 444, port: undefined },
    ] })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/launch/runLaunch.test.ts`
Expected: FAIL（`runLaunch` 还没有 wt/win 分支，会落到 iterm 分支调用真实 osascript 或报错）。

- [ ] **Step 3: 实现 runLaunch 分支**

`src/launch/index.ts` 顶部 import 增加：

```typescript
import { runWt } from './wt.js'
import { runWin } from './win.js'
import { resolvePsHost } from './platform.js'
```

`runLaunch` 改为（在 `print`/`tmux` 分支之后、`iterm` 之前插入 wt/win）：

```typescript
export async function runLaunch(specs: LaunchSpec[], strategy: Strategy): Promise<LaunchResult> {
  if (strategy === 'print') { console.log(renderPrint(specs)); return null }
  if (strategy === 'tmux') {
    const { session, paneIds } = await runTmux(specs)
    const services: RunService[] = specs.map((s, i) => ({ name: s.name, tmuxPaneId: paneIds[i] }))
    return { strategy: 'tmux', tmuxSession: session, services }
  }
  if (strategy === 'wt' || strategy === 'win') {
    const psHost = await resolvePsHost()
    const { pids } = strategy === 'wt' ? await runWt(specs, psHost) : await runWin(specs, psHost)
    const services: RunService[] = specs.map((s, i) => ({ name: s.name, pid: pids[i], port: s.port }))
    return { strategy, services }
  }
  const ids = await runIterm(specs)
  const services: RunService[] = specs.map((s, i) => ({ name: s.name, itermSessionId: ids[i] }))
  return { strategy: 'iterm', services }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/launch/runLaunch.test.ts`
Expected: PASS（2 passed）。

- [ ] **Step 5: typecheck + commit**

```bash
cd "C:/Users/Administrator/Workspace/bookkeeper"
npm run typecheck
git add src/launch/index.ts tests/launch/runLaunch.test.ts
git commit -m "feat(launch): runLaunch 接入 wt / win 分支"
```

---

### Task 7: 把 `hasWt` 注入 `doStart` / `doRestart`

让真实命令在 win32 上探测 wt 并传给 `selectStrategy`。有 `--tmux/--iterm/--print` 强制时跳过探测。

**Files:**
- Modify: `src/cli/commands/start.ts`（import + 第 22 行附近）
- Modify: `src/cli/commands/restart.ts`（import + 第 35 行）
- Test: `tests/launch/select.test.ts` 已覆盖纯函数；本任务靠现有 `tests/cli/start.flow.test.ts` 回归（不新增断言，确保 force 路径不触发探测）。

**Interfaces:**
- Consumes: `hasWindowsTerminal`（Task 3）、`selectStrategy`（Task 2）。
- Produces: 无新导出（仅接线）。

- [ ] **Step 1: 改 start.ts**

`src/cli/commands/start.ts` 顶部 import 增加：

```typescript
import { hasWindowsTerminal } from '../../launch/platform.js'
```

把第 22 行替换为（强制策略时不探测 wt）：

```typescript
  const hasWt = force ? false : await hasWindowsTerminal(env)
  const launched = await runLaunch(specs, selectStrategy(env, { force, hasWt }))
```

- [ ] **Step 2: 改 restart.ts**

`src/cli/commands/restart.ts` 顶部 import 增加：

```typescript
import { hasWindowsTerminal } from '../../launch/platform.js'
```

把第 35 行替换为（无既有 run 时才探测）：

```typescript
  const strategy = run?.strategy ?? selectStrategy(env, { hasWt: await hasWindowsTerminal(env) })
```

- [ ] **Step 3: 跑回归测试确认通过**

Run: `npx vitest run tests/cli/start.flow.test.ts tests/cli/restart.flow.test.ts`
Expected: PASS（force 路径不触发 `where wt`；现有断言不变）。

> 说明：`start.flow.test.ts` 用 `vi.mock('execa')` 且所有用例都传 force（`'iterm'`/`'print'`），故 `hasWt` 恒为 false、不会调用 `where`。

- [ ] **Step 4: typecheck + 全量测试**

```bash
cd "C:/Users/Administrator/Workspace/bookkeeper"
npm run typecheck
npx vitest run tests/launch tests/cli/start.flow.test.ts tests/cli/restart.flow.test.ts
```
Expected: 全绿。

- [ ] **Step 5: commit**

```bash
git add src/cli/commands/start.ts src/cli/commands/restart.ts
git commit -m "feat(cli): start/restart 在 win32 探测 wt 并注入 selectStrategy"
```

---

### Task 8: `bk stop` 按 PID 杀树 + 端口兜底

`stop.ts` 增加 `wt`/`win` 分支：优先按 `s.pid` `taskkill /T /F` 杀整棵树；无 pid 但有 `port` 时经 `Get-NetTCPConnection` 查属主再杀。

**Files:**
- Modify: `src/launch/stop.ts`
- Test: `tests/launch/stop.test.ts`（在现有文件追加用例）

**Interfaces:**
- Consumes: `RunRecord` / `RunService`（含 `pid?`/`port?`，Task 1）。
- Produces: `stopRun` 对 `wt`/`win` 句柄的停服行为（无新导出）。

- [ ] **Step 1: 写失败测试（追加到 stop.test.ts）**

在 `tests/launch/stop.test.ts` 的 `describe('stopRun', …)` 内追加用例（沿用文件顶部已 mock 的 `execa`）：

```typescript
  it('win：按 pid → taskkill /PID /T /F', async () => {
    const run = { strategy: 'win' as const, startedAt: 't',
      services: [{ name: 'a', pid: 4321, port: 10002 }] }
    const rem = await stopRun(run)
    expect(mockExeca).toHaveBeenCalledWith('taskkill', ['/PID', '4321', '/T', '/F'])
    expect(rem).toBeNull()
  })

  it('wt：无 pid 但有 port → 先 Get-NetTCPConnection 查属主再 taskkill', async () => {
    mockExeca.mockReset()
    // 第一次（powershell 查端口）返回 pid 文本；其余返回空
    mockExeca.mockResolvedValueOnce({ stdout: '9999' } as never)
                .mockResolvedValue({ stdout: '' } as never)
    const run = { strategy: 'wt' as const, startedAt: 't',
      services: [{ name: 'a', port: 10002 }] }
    await stopRun(run)
    const files = mockExeca.mock.calls.map(c => c[0])
    expect(files).toContain('powershell')
    expect(mockExeca).toHaveBeenCalledWith('taskkill', ['/PID', '9999', '/T', '/F'])
  })

  it('win：无 pid 无 port → 不调用 taskkill（幂等跳过）', async () => {
    const run = { strategy: 'win' as const, startedAt: 't',
      services: [{ name: 'a' }] }
    await stopRun(run)
    const files = mockExeca.mock.calls.map(c => c[0])
    expect(files).not.toContain('taskkill')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/launch/stop.test.ts`
Expected: FAIL（新增 3 个 win/wt 用例挂——`stop.ts` 还没有该分支）。

- [ ] **Step 3: 实现 stop.ts 分支**

把 `src/launch/stop.ts` 整文件替换为：

```typescript
import { execa } from 'execa'
import type { RunRecord, RunService } from '../core/types.js'

// 容错执行：句柄已失效（session/pane/进程 不存在）时吞错，视为已停。
async function tryExec(file: string, args: string[]): Promise<void> {
  try { await execa(file, args) } catch { /* 已不存在，视为已停 */ }
}

// 按端口查监听进程的 PID（wt/win 的兜底；pidfile 缺失时用）。
async function pidOnPort(port: number): Promise<number | undefined> {
  try {
    const { stdout } = await execa('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue` +
      ` | Select-Object -First 1 -ExpandProperty OwningProcess`])
    const pid = parseInt(stdout.trim(), 10)
    return Number.isNaN(pid) ? undefined : pid
  } catch { return undefined }
}

async function closeService(strategy: RunRecord['strategy'], s: RunService): Promise<void> {
  if (strategy === 'iterm' && s.itermSessionId)
    await tryExec('osascript',
      ['-e', `tell application "iTerm2" to tell session id "${s.itermSessionId}" to close`])
  else if (strategy === 'tmux' && s.tmuxPaneId)
    await tryExec('tmux', ['kill-pane', '-t', s.tmuxPaneId])
  else if (strategy === 'wt' || strategy === 'win') {
    let pid = s.pid
    if (pid === undefined && s.port !== undefined) pid = await pidOnPort(s.port)
    if (pid !== undefined) await tryExec('taskkill', ['/PID', String(pid), '/T', '/F'])
  }
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

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/launch/stop.test.ts`
Expected: PASS（含原有 iterm/tmux 用例与新增 3 个 win/wt 用例）。

- [ ] **Step 5: typecheck + commit**

```bash
cd "C:/Users/Administrator/Workspace/bookkeeper"
npm run typecheck
git add src/launch/stop.ts tests/launch/stop.test.ts
git commit -m "feat(launch): stop 按 PID 杀树 + 端口兜底（wt / win）"
```

---

### Task 9: `post_allocate` 改用平台 shell

把 `execa('sh', ['-c', cmd])` 换成 `execa(cmd, { shell: true })`，Unix 走 `/bin/sh`、Windows 走 `cmd.exe`，两者都支持 `&&`。同时把 `post_allocate` 测试里 `sh`-专属的 `$VAR` 展开用例改写为 shell 无关的 `node -e`（读 `process.env`），使其在 Windows 的 cmd.exe 下也成立。

**Files:**
- Modify: `src/hooks/postAllocate.ts:25`
- Test: `tests/hooks/postAllocate.test.ts:15-22`（重写首个用例的命令）

**Interfaces:**
- Consumes: 无。
- Produces: 无（行为修复）。

- [ ] **Step 1: 改写测试为 shell 无关命令**

把 `tests/hooks/postAllocate.test.ts` 第一个用例（line 15-22）替换为：

```typescript
  it('在 service 的 dir 下运行、注入 BK_N 与该目录的 BK_*', async () => {
    mkdirSync(join(wt, 'backend'))
    // 用 node -e 读 process.env，避免依赖具体 shell 的变量展开语法（sh 用 $VAR，cmd 用 %VAR%）
    const c = ctx([{ name: 'backend', type: 'django', dir: 'backend',
      post_allocate:
        `node -e "require('fs').writeFileSync('out.txt', process.env.BK_N + '-' + process.env.BK_DB_NAME)"` }])
    const dirEnvs = new Map([['backend', { BK_DB_NAME: 'foo_2' }]])
    await runPostAllocate(c, wt, dirEnvs, 2)
    expect(readFileSync(join(wt, 'backend', 'out.txt'), 'utf8').trim()).toBe('2-foo_2')
  })
```

> `exit 3` / `echo hi > b.txt` 两个用例在 sh 与 cmd.exe 下行为一致，无需改。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/hooks/postAllocate.test.ts`
Expected: FAIL —— 在 Windows 上当前实现用 `sh`，若无 `sh` 则全挂；若有 `sh`（git bash），改写后的 `node -e` 用例仍可能因 `sh` 解析双引号方式不同而行为不稳。无论哪种，目标是切到 `shell:true` 后稳定通过。（关键是下一步实现后变绿。）

- [ ] **Step 3: 改 postAllocate.ts**

`src/hooks/postAllocate.ts` 把第 25 行：

```typescript
    const result = await execa('sh', ['-c', cmd], { cwd, env, stdio: 'inherit', reject: false })
```

替换为：

```typescript
    // shell:true → Unix 用 /bin/sh、Windows 用 cmd.exe；两者都支持 && 链
    const result = await execa(cmd, { cwd, env, stdio: 'inherit', reject: false, shell: true })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/hooks/postAllocate.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: typecheck + commit**

```bash
cd "C:/Users/Administrator/Workspace/bookkeeper"
npm run typecheck
git add src/hooks/postAllocate.ts tests/hooks/postAllocate.test.ts
git commit -m "fix(hooks): post_allocate 改用平台 shell（Windows 走 cmd.exe）"
```

---

### Task 10: 修 `tmux.ts` 路径 bug + 路径清扫

`tmux.ts` 用 `cwd.split('/').pop()` 取 basename，Windows 反斜杠路径会坏；改用 `path.basename`。再 grep 全代码库其余 `/`-字面量路径操作并修。

**Files:**
- Modify: `src/launch/tmux.ts:1,7`
- Test: `tests/launch/tmux.test.ts`（追加反斜杠 cwd 用例）

**Interfaces:**
- Consumes: 无。
- Produces: 无（正确性修复）。

- [ ] **Step 1: 写失败测试（追加到 tmux.test.ts）**

在 `tests/launch/tmux.test.ts` 的 `describe('runTmux', …)` 内追加：

```typescript
  it('Windows 反斜杠 cwd → session 名取末段 basename', async () => {
    const r = await runTmux([spec('backend', 'C:\\wt\\backend')])
    expect(r.session).toBe('bk-backend')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/launch/tmux.test.ts`
Expected: FAIL —— `'C:\\wt\\backend'.split('/').pop()` 返回整串 `C:\wt\backend`，session 变成 `bk-C:\wt\backend`。

- [ ] **Step 3: 改 tmux.ts**

`src/launch/tmux.ts` 顶部加 import：

```typescript
import { basename } from 'node:path'
```

把第 7 行（原 `const session = ...split('/').pop()`）替换为：

```typescript
  const session = `bk-${basename(first.cwd)}`
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/launch/tmux.test.ts`
Expected: PASS（原有 3 用例 + 新增 1 用例）。

- [ ] **Step 5: 全库路径清扫**

Run（grep 其余可疑的 `/`-字面量路径切割；providers 是网络客户端、`config/discover.ts` 已用 `node:path`，预期无新命中需改）：

```bash
cd "C:/Users/Administrator/Workspace/bookkeeper"
git grep -nE "split\('/'\)|split\(\"/\"\)" -- src
```
Expected: 仅历史已知项，无 `tmux.ts` 之外的路径切割。若有命中（非 URL/非 key 拼接的真实文件路径），同样改用 `node:path`。

- [ ] **Step 6: typecheck + commit**

```bash
cd "C:/Users/Administrator/Workspace/bookkeeper"
npm run typecheck
git add src/launch/tmux.ts tests/launch/tmux.test.ts
git commit -m "fix(launch): tmux session 名用 path.basename（修 Windows 反斜杠路径）"
```

---

### Task 11: 全量验证 + 文档 + 版本 bump

确认整套测试绿，更新 README（Windows 章节）与 CHANGELOG，bump 版本号到 0.0.10。

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json:3`（version）

**Interfaces:**
- Consumes: 无。
- Produces: 无。

- [ ] **Step 1: 全量测试 + typecheck + 构建**

```bash
cd "C:/Users/Administrator/Workspace/bookkeeper"
npm run typecheck
npx vitest run --exclude "**/*.integration.test.ts"
npm run build
```
Expected: typecheck 无错；测试全绿（集成测试需 Docker，按需跳过）；`tsup` 构建出 `dist/`。

- [ ] **Step 2: 更新 CHANGELOG.md**

在 `CHANGELOG.md` 顶部 `# Changelog` 与首个版本块之间插入：

```markdown
## [0.0.10] - 2026-06-27

### Added

- **Windows 支持**：`bk start` 在 Windows 上按是否安装 Windows Terminal 自动选策略——有 `wt.exe` 用 `wt`（单窗口平铺多 pane），否则用 `win`（每服务一个独立 PowerShell 窗口）。`stop`/`restart` 据此停服：优先按记录的 PID `taskkill /T /F` 杀整棵进程树，PID 缺失时按服务端口经 `Get-NetTCPConnection` 查属主兜底（无端口的 worker 依赖 wt pane 自报的 pidfile）。服务宿主优先 `pwsh`（PowerShell 7）、否则内置 `powershell` 5.1。

### Fixed

- `post_allocate` 钩子改用平台默认 shell 执行（Unix `/bin/sh`、Windows `cmd.exe`），此前硬编码 `sh -c` 在 Windows 上不可用，导致带 `post_allocate` 的 `bk allocate` 失败。
- `tmux` 会话名改用 `path.basename` 推导，修正 Windows 反斜杠 worktree 路径下会话名被整条路径污染的问题。
```

- [ ] **Step 3: 更新 README.md（新增 Windows 章节）**

在 README 中「启动服务 / `bk start`」相关章节之后（紧邻 tmux/iTerm 说明处）插入：

```markdown
## Windows 支持

`bk start` 在 Windows 上自动选择启动方式：

- **装了 Windows Terminal（`wt.exe`）** → 用 `wt`：在一个窗口里平铺多个 pane，每个 pane 跑一个服务（最接近 tmux/iTerm 的体验）。
- **没装** → 用 `win`：每个服务起一个独立的 PowerShell 窗口。

服务宿主优先用 PowerShell 7（`pwsh`），没有则回退系统自带的 `powershell` 5.1。

`bk stop` / `bk restart`：

- 优先按 `bk start` 记录的 PID `taskkill /T /F` 杀整棵进程树。
- PID 失效时，对**有端口**的服务按端口经 `Get-NetTCPConnection` 反查属主进程兜底。
- 无端口的 worker（arq/celery）依赖 `wt` pane 自报的 pidfile。

### 已知限制

- 服务的 **`command` 覆盖**里若用 `&&`，在仅有 PowerShell 5.1 的机器上不可用——请装 PowerShell 7（`pwsh`），或拆成单条命令。内置默认启动命令都是单条命令，不受影响。
- `wt` 下被 `stop` 的 pane 会显示「进程已退出」但 pane 不会自动关闭，需手动关（与 tmux 死 pane 同理）。
```

- [ ] **Step 4: bump 版本号**

`package.json` 第 3 行：

```json
  "version": "0.0.10",
```

- [ ] **Step 5: commit**

```bash
cd "C:/Users/Administrator/Workspace/bookkeeper"
git add README.md CHANGELOG.md package.json
git commit -m "chore: 发版 0.0.10（Windows 支持）"
```

---

## Self-Review

**Spec coverage：**
- §1 策略选择 → Task 2（selectStrategy win32 分支）+ Task 7（接线 hasWt）。
- §2 两个启动器（wt + win）→ Task 4、Task 5；runLaunch 接入 → Task 6。偏差（不复用 planGrid）已在顶部「与 spec 的一处偏差」说明。
- §3 句柄模型（pid/port/strategy）→ Task 1。
- §4 stop/restart（pid + 端口兜底）→ Task 8（restart 自动复用，见其 §4 说明）。
- §5 post_allocate shell 修复 → Task 9。
- §6 路径/句柄 bug 清扫（tmux basename）→ Task 10。
- §7 测试 + 文档 → 各任务自带测试；文档与版本 → Task 11。
- 已知限制 1/2 → Task 11 README。

**Placeholder scan：** 无 TBD/TODO；每个 code step 都给了完整代码与确切命令。

**Type consistency：** `RunService.pid/port`、`RunHandle.strategy`、`LaunchSpec.port`、`Strategy` 联合、`runWt/runWin` 返回 `{ pids }`、`buildWinSpawn/buildWtArgs/pidFileFor/resolvePsHost/hasWindowsTerminal` 签名在 Task 1–8 间一致引用。`selectStrategy(env, opts)` 新签名在 Task 2 定义、Task 7 使用，select.test 同步更新。
