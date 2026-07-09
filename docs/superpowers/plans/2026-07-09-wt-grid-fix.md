# wt 网格修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 0.0.10 `wt` 策略的两个真机实证 bug——`-Command` 内嵌 `;` 被 WT 拆分导致服务从未启动（假成功）、瀑布式对半分屏导致 pane 塌缩与 split 失败——使 `bk start` 在 Windows Terminal 下以均匀网格真正启动全部服务。

**Architecture:** pane 命令载体从内嵌 `-Command` 改为每服务一个 `.ps1` 启动脚本（`-ExecutionPolicy Bypass -File`），wt argv 中不再出现用户命令文本；分屏从裸 `split-pane` 瀑布切改为复用 iTerm planGrid 网格几何（抽出共用 `gridShape`），以「先切列、再右→左逐列切行、列间 `move-focus left`」的聚焦相对序列构造。stop/restart、`win.ts`、`selectStrategy`、hooks、资源/配置/状态层全部不动。

**Tech Stack:** TypeScript（ESM，import 带 `.js` 后缀）、Node ≥20、execa v9、vitest、Windows Terminal `wt.exe`（split-pane `-H`/`-V`/`--size`、`move-focus`，需 ≥1.7）、PowerShell（`pwsh` 优先，`powershell` 5.1 兜底）。

**Spec:** `docs/superpowers/specs/2026-07-09-wt-grid-fix-design.md`（实测数据表与决策依据见 spec）。

## Global Constraints

- Node ≥ 20；项目为 ESM（`"type":"module"`），**所有相对 import 必须带 `.js` 后缀**。
- 代码注释与用户可见字符串用中文，匹配现有风格。
- execa v9 API：`execa(file, args?, opts?)`。
- 测试跑法：`npx vitest run <file>`（单文件）、`npm test`（全量）、`npm run typecheck`。
- 版本号从 `0.0.10` bump 到 `0.0.11`（仅 Task 4 做）。
- `runWt(specs, psHost)` 公开签名不变；`runLaunch`、`stop.ts`、`win.ts`、`selectStrategy`、`platform.ts` 不改。
- 每个任务结束都 `npm run typecheck` 通过、相关测试绿、然后 commit。

## 网格形状与构造序列（Task 1/3 共同依据）

`gridShape(n)`：`cols = ceil(√n)`，`rows = ceil(n/cols)`，`fullCols = n − cols·(rows−1)`；前 `fullCols` 列放 `rows` 格、其余列放 `rows−1` 格；服务按**列优先**填充（与 iTerm 一致）。例：2→[1,1]、3→[2,1]、4→[2,2]、5→[2,2,1]、6→[2,2,2]、7→[3,2,2]、10→[3,3,2,2]。

WT 构造序列（`split-pane` 只作用于聚焦 pane、切后焦点在新 pane；WT 无 pane 寻址，用 `move-focus` 导航）：

1. `new-tab` = 格 (col 0, row 0)；
2. 左→右切等宽列：c = 1..cols−1 依次 `split-pane -V --size (cols−c)/(cols−c+1)`，pane 内容 = 第 c 列首格服务；
3. 最右列→左：列内 r = 1..cnt−1 依次 `split-pane -H --size (cnt−r)/(cnt−r+1)`（自上而下）；切完一列且左侧还有需切行的列时 `move-focus left`（左邻列此时必为单一整列 pane，方向无歧义）。

wt argv 的子命令顺序 ≠ 服务下标顺序（构造顺序为：各列首格左→右，再右→左补各列行），由列优先下标映射保证每个 pane 拿到正确服务。

---

### Task 1: `gridShape` 共用网格形状（iterm 接入）

抽出 planGrid 里的形状计算为共用纯函数，wt 与 iterm 共用；iterm 行为零变化（现有 `itermGrid.test.ts` 全绿是硬门槛）。

**Files:**
- Create: `src/launch/grid.ts`
- Create: `tests/launch/grid.test.ts`
- Modify: `src/launch/itermGrid.ts:16-20`

**Interfaces:**
- Consumes: 无（基础任务）。
- Produces: `gridShape(n: number): number[]` —— 返回每列格数（长度 = 列数）；`n ≤ 0` 返回 `[]`。Task 3 的 `buildWtArgs` 依赖它。

- [ ] **Step 1: 写失败测试**

新建 `tests/launch/grid.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { gridShape } from '../../src/launch/grid.js'

describe('gridShape', () => {
  it('n<=0 → []', () => {
    expect(gridShape(0)).toEqual([])
    expect(gridShape(-1)).toEqual([])
  })
  const cases: [number, number[]][] = [
    [1, [1]], [2, [1, 1]], [3, [2, 1]], [4, [2, 2]], [5, [2, 2, 1]],
    [6, [2, 2, 2]], [7, [3, 2, 2]], [10, [3, 3, 2, 2]], [12, [3, 3, 3, 3]],
  ]
  for (const [n, want] of cases)
    it(`n=${n} → [${want.join(',')}]`, () => expect(gridShape(n)).toEqual(want))
  it('总格数守恒：sum(colCounts) === n（n=1..30）', () => {
    for (let n = 1; n <= 30; n++)
      expect(gridShape(n).reduce((a, b) => a + b, 0)).toBe(n)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/launch/grid.test.ts`
Expected: FAIL —— `Cannot find module '../../src/launch/grid.js'`

- [ ] **Step 3: 实现 `gridShape`**

新建 `src/launch/grid.ts`：

```typescript
// 均匀网格形状（wt 与 iterm 共用）：cols = ceil(sqrt(n))，列优先填充。
// 返回每列格数（数组长度即列数）；n<=0 返回 []。
export function gridShape(n: number): number[] {
  if (n <= 0) return []
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const fullCols = n - cols * (rows - 1)
  return Array.from({ length: cols }, (_, c) => (c < fullCols ? rows : rows - 1))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/launch/grid.test.ts`
Expected: PASS（12 个用例）

- [ ] **Step 5: itermGrid 改用 `gridShape`**

修改 `src/launch/itermGrid.ts`：文件头加 import，`planGrid` 内删掉自算形状的 4 行、改为调用。

改动前（第 16–20 行）：

```typescript
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  // 列优先填充：前 fullCols 列放满 rows 格，其余列放 rows-1 格
  const fullCols = n - cols * (rows - 1)
  const colCounts = Array.from({ length: cols }, (_, c) => (c < fullCols ? rows : rows - 1))
```

改动后：

```typescript
  const colCounts = gridShape(n)
  const cols = colCounts.length
```

并在文件顶部（`export type SplitDir` 之前）加：

```typescript
import { gridShape } from './grid.js'
```

其余（bisect、steps、order）一字不动。

- [ ] **Step 6: 跑 iterm 相关测试确认零回归**

Run: `npx vitest run tests/launch/grid.test.ts tests/launch/itermGrid.test.ts tests/launch/iterm.test.ts`
Expected: PASS 全绿（itermGrid 的边界/不变量/均匀度/列优先映射用例全部保持）

- [ ] **Step 7: typecheck + commit**

```bash
npm run typecheck
git add src/launch/grid.ts src/launch/itermGrid.ts tests/launch/grid.test.ts
git commit -m "feat(launch): gridShape 共用网格形状（planGrid 抽取，iterm 零行为变化）"
```

---

### Task 2: pane 启动脚本 helper（`.ps1` 载体，暂未接线）

新增启动脚本的路径与内容纯函数。此任务不动 `paneScript`/`buildWtArgs`/`runWt`，旧测试保持绿——接线在 Task 3。

**Files:**
- Modify: `src/launch/wt.ts:9-19`（`pidFileFor` 区域重构 + 新增两个导出）
- Modify: `tests/launch/wt.test.ts`（文件末尾追加两个 describe）

**Interfaces:**
- Consumes: `LaunchSpec`（`src/launch/index.ts:12`，`{ name, command, cwd, port? }`）。
- Produces（Task 3 依赖）:
  - `launcherScriptFor(spec: LaunchSpec): string` —— `<tmp>/bk-run/<key>.ps1`，与 `pidFileFor` 同 key。
  - `launcherScriptContent(command: string, pidFile: string): string` —— 两行脚本文本。

- [ ] **Step 1: 写失败测试**

在 `tests/launch/wt.test.ts` 末尾追加（import 行同步加上 `launcherScriptFor, launcherScriptContent`）：

```typescript
describe('launcherScriptFor', () => {
  it('与 pidFileFor 同 key，以 .ps1 结尾', () => {
    expect(launcherScriptFor(specs[0])).toBe(pidFileFor(specs[0]).replace(/\.pid$/, '.ps1'))
  })
})

describe('launcherScriptContent', () => {
  it('第一行写宿主 $PID 到 pidfile，第二行原命令', () => {
    expect(launcherScriptContent('npm run dev', 'C:\\tmp\\x.pid'))
      .toBe("$PID | Out-File -Encoding ascii 'C:\\tmp\\x.pid'\nnpm run dev\n")
  })
  it("pidfile 路径中的单引号按 PowerShell 规则转义（' → ''）", () => {
    expect(launcherScriptContent('x', "C:\\it's\\x.pid")).toContain("'C:\\it''s\\x.pid'")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/launch/wt.test.ts`
Expected: FAIL —— `launcherScriptFor` 未导出（SyntaxError/undefined）

- [ ] **Step 3: 实现 helper**

修改 `src/launch/wt.ts`：把现有 `pidFileFor`（第 9–13 行）重构为共享 key + 两个路径函数，并新增内容函数。改动后该区域为：

```typescript
// 用 cwd + name 唯一定位运行时文件（每个 worktree 的 cwd 互不相同）。
function runKeyFor(spec: LaunchSpec): string {
  return `${spec.cwd}__${spec.name}`.replace(/[^A-Za-z0-9]+/g, '_')
}
export function pidFileFor(spec: LaunchSpec): string {
  return join(PID_DIR, `${runKeyFor(spec)}.pid`)
}
export function launcherScriptFor(spec: LaunchSpec): string {
  return join(PID_DIR, `${runKeyFor(spec)}.ps1`)
}

// pane 启动脚本：先把 PowerShell 宿主 $PID 写进 pidfile，再跑服务命令。
// 注：$PID 为宿主进程 PID，服务作为其子进程运行，bk stop 须 taskkill /T 才能树杀到子进程。
// 命令以 -File 落盘执行——wt argv 中不出现用户命令文本，
// 从根上避免 execa→wt→PowerShell 三层引号/元字符（; " & …）转义问题。
export function launcherScriptContent(command: string, pidFile: string): string {
  const escaped = pidFile.replace(/'/g, "''")
  return `$PID | Out-File -Encoding ascii '${escaped}'\n${command}\n`
}
```

（此步保留现有 `paneScript` 与 `buildWtArgs` 原样不动。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/launch/wt.test.ts`
Expected: PASS（旧 describe + 新增 3 个用例全绿）

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/launch/wt.ts tests/launch/wt.test.ts
git commit -m "feat(launch): wt pane 启动脚本 helper（.ps1 路径与内容）"
```

---

### Task 3: `buildWtArgs` 网格构造重写 + `runWt` 接线

核心修复：argv 换成网格构造序列 + `-File` 载体；`runWt` 启动前落盘脚本。删除 `paneScript`。`tests/launch/wt.test.ts` 整文件替换。

**Files:**
- Modify: `src/launch/wt.ts`（全文件替换，最终形态见 Step 3）
- Modify: `tests/launch/wt.test.ts`（全文件替换，最终形态见 Step 1）

**Interfaces:**
- Consumes: `gridShape`（Task 1）、`launcherScriptFor`/`launcherScriptContent`（Task 2）。
- Produces:
  - `buildWtArgs(specs: LaunchSpec[], psHost: string, scriptFiles: string[]): string[]`（第三参从 pidFiles 改为 scriptFiles）。
  - `runWt(specs, psHost)` 签名与返回不变（`{ pids: (number | undefined)[] }`）——`runLaunch` 无需改动。

- [ ] **Step 1: 整文件替换测试**

`tests/launch/wt.test.ts` 全文件替换为：

```typescript
import { describe, it, expect } from 'vitest'
import { buildWtArgs, pidFileFor, launcherScriptFor, launcherScriptContent } from '../../src/launch/wt.js'
import type { LaunchSpec } from '../../src/launch/index.js'

const mk = (n: number): LaunchSpec[] => Array.from({ length: n }, (_, i) => (
  { name: `s${i + 1}`, command: `cmd${i + 1}`, cwd: `C:\\wt\\s${i + 1}`, port: 10000 + i }))
const scripts = (specs: LaunchSpec[]) => specs.map(launcherScriptFor)

describe('运行时文件路径', () => {
  const specs = mk(2)
  it('同 cwd 不同 name → 不同 pidfile', () => {
    expect(pidFileFor(specs[0])).not.toBe(pidFileFor(specs[1]))
  })
  it('pidfile 以 .pid 结尾', () => expect(pidFileFor(specs[0]).endsWith('.pid')).toBe(true))
  it('启动脚本与 pidfile 同 key，以 .ps1 结尾', () => {
    expect(launcherScriptFor(specs[0])).toBe(pidFileFor(specs[0]).replace(/\.pid$/, '.ps1'))
  })
})

describe('launcherScriptContent', () => {
  it('第一行写宿主 $PID 到 pidfile，第二行原命令', () => {
    expect(launcherScriptContent('npm run dev', 'C:\\tmp\\x.pid'))
      .toBe("$PID | Out-File -Encoding ascii 'C:\\tmp\\x.pid'\nnpm run dev\n")
  })
  it("pidfile 路径中的单引号按 PowerShell 规则转义（' → ''）", () => {
    expect(launcherScriptContent('x', "C:\\it's\\x.pid")).toContain("'C:\\it''s\\x.pid'")
  })
})

describe('buildWtArgs 网格构造', () => {
  it('k=1: 仅 new-tab，无 split-pane/move-focus', () => {
    const s = mk(1)
    const args = buildWtArgs(s, 'powershell', scripts(s))
    expect(args[0]).toBe('new-tab')
    expect(args).not.toContain('split-pane')
    expect(args).not.toContain('move-focus')
  })
  it('k=2: pane 参数结构 = -d cwd --title name psHost -NoExit -ExecutionPolicy Bypass -File script', () => {
    const s = mk(2)
    const sf = scripts(s)
    const args = buildWtArgs(s, 'powershell', sf)
    expect(args.slice(0, 11)).toEqual(['new-tab', '-d', 'C:\\wt\\s1', '--title', 's1',
      'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', sf[0]])
  })
  it('k=2: 一次 -V 对半切，无 -H、无 move-focus', () => {
    const s = mk(2)
    const args = buildWtArgs(s, 'powershell', scripts(s))
    expect(args.filter(a => a === 'split-pane')).toHaveLength(1)
    expect(args).toContain('-V')
    expect(args).toContain('0.5000')
    expect(args).not.toContain('-H')
    expect(args).not.toContain('move-focus')
  })
  it('k=6（3 列 × 2 行）: 5 次 split、尺寸序列、2 次 move-focus', () => {
    const s = mk(6)
    const args = buildWtArgs(s, 'pwsh', scripts(s))
    expect(args.filter(a => a === 'split-pane')).toHaveLength(5)
    const sizes = args.flatMap((a, i) => (a === '--size' ? [args[i + 1]] : []))
    expect(sizes).toEqual(['0.6667', '0.5000', '0.5000', '0.5000', '0.5000'])
    expect(args.filter(a => a === 'move-focus')).toHaveLength(2)
  })
  it('k=5（列数 [2,2,1]）: 服务按列优先落格，构造顺序 = s1,s3,s5,s4,s2', () => {
    const s = mk(5)
    const sf = scripts(s)
    const args = buildWtArgs(s, 'pwsh', sf)
    const seq = args.filter(a => sf.includes(a)).map(a => sf.indexOf(a) + 1)
    expect(seq).toEqual([1, 3, 5, 4, 2])
  })
  it('argv 不含用户命令文本；; 仅作为独立的子命令分隔符元素出现', () => {
    const s: LaunchSpec[] = [
      { name: 'a', command: 'echo "x"; dir && whoami', cwd: 'C:\\wt\\a' },
      { name: 'b', command: 'npm run dev -- --port 1', cwd: 'C:\\wt\\b' },
    ]
    const args = buildWtArgs(s, 'powershell', scripts(s))
    const joined = args.join(' ')
    expect(joined).not.toContain('echo')
    expect(joined).not.toContain('npm run dev')
    for (const a of args) if (a.includes(';')) expect(a).toBe(';')
  })
  it('宿主可执行用传入的 psHost', () => {
    const s = mk(2)
    expect(buildWtArgs(s, 'pwsh', scripts(s))).toContain('pwsh')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/launch/wt.test.ts`
Expected: FAIL —— 网格构造用例失败（现实现为裸 split-pane、第三参为 pidFiles、argv 含命令文本）

- [ ] **Step 3: 整文件替换实现**

`src/launch/wt.ts` 全文件替换为：

```typescript
import { execa } from 'execa'
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LaunchSpec } from './index.js'
import { gridShape } from './grid.js'

const PID_DIR = join(tmpdir(), 'bk-run')

// 用 cwd + name 唯一定位运行时文件（每个 worktree 的 cwd 互不相同）。
function runKeyFor(spec: LaunchSpec): string {
  return `${spec.cwd}__${spec.name}`.replace(/[^A-Za-z0-9]+/g, '_')
}
export function pidFileFor(spec: LaunchSpec): string {
  return join(PID_DIR, `${runKeyFor(spec)}.pid`)
}
export function launcherScriptFor(spec: LaunchSpec): string {
  return join(PID_DIR, `${runKeyFor(spec)}.ps1`)
}

// pane 启动脚本：先把 PowerShell 宿主 $PID 写进 pidfile，再跑服务命令。
// 注：$PID 为宿主进程 PID，服务作为其子进程运行，bk stop 须 taskkill /T 才能树杀到子进程。
// 命令以 -File 落盘执行——wt argv 中不出现用户命令文本，
// 从根上避免 execa→wt→PowerShell 三层引号/元字符（; " & …）转义问题。
export function launcherScriptContent(command: string, pidFile: string): string {
  const escaped = pidFile.replace(/'/g, "''")
  return `$PID | Out-File -Encoding ascii '${escaped}'\n${command}\n`
}

// 构建 wt argv：planGrid 同款均匀网格（列优先），聚焦相对构造。
// 1) new-tab = 格(0,0)；2) 左→右切等宽列（-V）；3) 最右列→左逐列自上而下切行（-H），
// 列间 move-focus left（左邻列此时必为单一整列 pane，方向无歧义）。
// --size 为新 pane 占被切 pane 的比例，依次 (m-1)/m 得到等分。
export function buildWtArgs(specs: LaunchSpec[], psHost: string, scriptFiles: string[]): string[] {
  const counts = gridShape(specs.length)
  const cols = counts.length
  // 列优先下标：第 c 列首格的 service 下标 = 前面各列格数之和
  const first = (c: number) => counts.slice(0, c).reduce((a, b) => a + b, 0)
  const pane = (i: number) => ['-d', specs[i].cwd, '--title', specs[i].name,
    psHost, '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptFiles[i]]
  const args = ['new-tab', ...pane(0)]
  for (let c = 1; c < cols; c++)
    args.push(';', 'split-pane', '-V', '--size',
      ((cols - c) / (cols - c + 1)).toFixed(4), ...pane(first(c)))
  for (let c = cols - 1; c >= 0; c--) {
    for (let r = 1; r < counts[c]; r++)
      args.push(';', 'split-pane', '-H', '--size',
        ((counts[c] - r) / (counts[c] - r + 1)).toFixed(4), ...pane(first(c) + r))
    if (c > 0 && counts.slice(0, c).some(x => x > 1)) args.push(';', 'move-focus', 'left')
  }
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
  const scriptFiles = specs.map(launcherScriptFor)
  mkdirSync(PID_DIR, { recursive: true })
  for (const f of pidFiles) { try { rmSync(f) } catch { /* 无旧文件 */ } }
  specs.forEach((s, i) => writeFileSync(scriptFiles[i], launcherScriptContent(s.command, pidFiles[i])))
  await execa('wt', buildWtArgs(specs, psHost, scriptFiles))
  const pids = await Promise.all(pidFiles.map(readPid))
  return { pids }
}
```

要点核对（实现时自查）：`paneScript` 已删除；`dirname` import 已删除（`mkdirSync(PID_DIR)` 直接建目录）；`writeFileSync` 已加入 import。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/launch/wt.test.ts tests/launch/runLaunch.test.ts`
Expected: PASS 全绿（`runWt` 公开签名未变，runLaunch 测试不受影响）

- [ ] **Step 5: typecheck + 全量测试 + commit**

```bash
npm run typecheck
npm test
git add src/launch/wt.ts tests/launch/wt.test.ts
git commit -m "fix(launch): wt 均匀网格构造 + .ps1 启动脚本载体（修复 ; 拆分假成功与瀑布分屏）"
```

---

### Task 4: 文档 + 版本 bump

CHANGELOG 0.0.11、README Windows 章节更新（网格描述；**删除已解除的 `;` 限制条目**；新增 WT 最小尺寸限制条目）、版本号。

**Files:**
- Modify: `CHANGELOG.md:4`（在 0.0.10 条目前插入）
- Modify: `README.md:237`、`README.md:248-252`
- Modify: `package.json:3`

**Interfaces:**
- Consumes: Task 3 的行为语义（网格布局、`;` 限制解除）。
- Produces: 无（文档任务）。

- [ ] **Step 1: CHANGELOG 插入 0.0.11**

在 `CHANGELOG.md` 第 4 行（`## [0.0.10] - 2026-06-28` 之前）插入：

```markdown
## [0.0.11] - 2026-07-09

### Fixed

- `wt` 策略：pane 命令此前以 `-Command` 内嵌字符串传入，写 pidfile 与服务命令之间的 `;` 被 `wt.exe` 误作子命令分隔符——服务命令被拆成独立 tab 且启动失败（`0x80070002`），而 pidfile 已写入导致 `bk start` 假成功。现改为每服务生成启动脚本（`<tmp>/bk-run/<key>.ps1`），pane 以 `-ExecutionPolicy Bypass -File` 执行，`wt` 命令行中不再出现用户命令文本，`;`/引号等元字符问题从根上消失（服务 `command` 覆盖中不能含 `;` 的限制随之解除）。
- `wt` 策略：分屏从「对最新 pane 反复对半切」改为与 iTerm 一致的均匀网格（列优先，如 4 服务 2×2、6 服务 3 列 × 2 行）。此前瀑布式切法使 pane 面积按 1/2、1/4、1/8…塌缩，5 个以上难以阅读，10 个服务时末尾 split 触及 Windows Terminal 最小 pane 尺寸而失败、对应服务不启动（真机实测 8/10）；均匀网格构造实测 10/10 全部启动。

```

- [ ] **Step 2: README 更新**

`README.md:237` 的 wt 条目替换为：

```markdown
- **装了 Windows Terminal（`wt.exe`）** → 用 `wt`：在一个窗口里按**均匀网格**平铺 pane（列优先：4 服务 2×2、6 服务 3 列 × 2 行、10 服务 4 列 3+3+2+2），每个 pane 跑一个服务（最接近 tmux/iTerm 的体验）。pane 标题设为服务名（可能被 shell 自身标题覆盖）。需较新版本 Windows Terminal（≥1.7，2021 年后版本均满足）。
```

「已知限制」小节（`README.md:248-252`）替换为（删除原 `;` 条目、新增最小尺寸条目、其余两条保留）：

```markdown
### 已知限制

- 服务的 **`command` 覆盖**里若用 `&&`，在仅有 PowerShell 5.1 的机器上不可用——请装 PowerShell 7（`pwsh`），或拆成单条命令。内置默认启动命令都是单条命令，不受影响。
- pane 数极多时 Windows Terminal 会因最小 pane 尺寸拒绝 split，对应服务不启动（默认窗口尺寸实测 10 个 pane OK）。服务更多时可在 WT 设置调大默认启动窗口（`initialCols`/`initialRows`）——`bk start` 每次开新窗口，放大现有窗口对下次启动无效。
- `wt` 下被 `stop` 的 pane 会显示「进程已退出」但 pane 不会自动关闭，需手动关（与 tmux 死 pane 同理）。
```

- [ ] **Step 3: 版本 bump**

`package.json:3`：`"version": "0.0.10"` → `"version": "0.0.11"`。

- [ ] **Step 4: 全量验证 + commit**

```bash
npm run typecheck
npm test
git add CHANGELOG.md README.md package.json
git commit -m "chore: 发版 0.0.11（wt 网格修复）"
```

Expected: typecheck 无错误；vitest 全绿（42+ 文件，容器相关 3 个 skip 正常）。

---

### Task 5: 真机冒烟验证（手动，Windows + Windows Terminal 机器）

mock 测不到 WT 对合并命令行的再解析与最小 pane 尺寸行为（本 bug 正是这样漏掉的）——修复必须在真机过一遍。lab fixture 已存在于 `C:\Users\Administrator\Workspace\bk-wt-lab`（`proj/` 为含 vite 的 bk 项目，`home/` 为隔离 BK_HOME，Set 1 已分配端口 15001..15901）。

**Files:**
- 无代码改动；产出为验证记录（截图/观察），不提交。

**Interfaces:**
- Consumes: Task 3 构建产物（`npm run build` 后的 `dist/cli/index.js`）。
- Produces: 验证结论，回写到本计划勾选框。

- [ ] **Step 1: 构建**

```powershell
cd C:\Users\Administrator\Workspace\bookkeeper.win-support
npm run build
```

Expected: `ESM dist\cli\index.js … Build success`

- [ ] **Step 2: 写入 6 服务 config**

`C:\Users\Administrator\Workspace\bk-wt-lab\proj\bk_config.yml` 整文件替换为：

```yaml
project_name: bkwtlab

services:
  svc01:
    type: vite
    port_base: 15000
    dir: app
  svc02:
    type: vite
    port_base: 15100
    dir: app
  svc03:
    type: vite
    port_base: 15200
    dir: app
  svc04:
    type: vite
    port_base: 15300
    dir: app
  svc05:
    type: vite
    port_base: 15400
    dir: app
  svc06:
    type: vite
    port_base: 15500
    dir: app
```

- [ ] **Step 3: start 并目测 3×2 网格**

```powershell
$env:BK_HOME = 'C:\Users\Administrator\Workspace\bk-wt-lab\home'
cd C:\Users\Administrator\Workspace\bk-wt-lab\proj
node C:\Users\Administrator\Workspace\bookkeeper.win-support\dist\cli\index.js start
```

Expected（全部满足才算过）:
- 新开一个 WT 窗口，**3 列 × 2 行六等分**（不是一大五小的瀑布）；
- 6 个 pane 各自显示 `VITE vX.Y.Z ready`，端口 15001/15101/15201/15301/15401/15501（列优先：左列上 15001、左列下 15101、中列上 15201…）；
- 无任何「0x80070002 系统找不到指定的档案」错误 tab。

- [ ] **Step 4: stop 验证**

```powershell
node C:\Users\Administrator\Workspace\bookkeeper.win-support\dist\cli\index.js stop
```

Expected: 输出「已停止当前 worktree 的服务」；6 个 pane 的进程全部退出（pane 显示进程已退出属正常观感）；`Test-NetConnection localhost -Port 15001` 连不通。

- [ ] **Step 5: 10 服务复测**

`bk_config.yml` 在 Step 2 基础上追加 svc07..svc10（port_base 15600/15700/15800/15900，`type: vite`、`dir: app` 同上），重复 Step 3/4。

Expected: **4 列、格数 3+3+2+2**，10 个 vite 全部 ready（对照修复前真机数据 8/10）；stop 全部退出。

- [ ] **Step 6: 清理**

手动关闭实验产生的 WT 窗口（死 pane 窗口）。lab 目录保留与否由用户定夺。

---

## Self-Review（计划完成后自查记录）

**Spec coverage：** spec §1 gridShape 抽取 → Task 1；§2 启动脚本 → Task 2 + Task 3 接线；§3 网格构造 → Task 3；§4 不动项 → Global Constraints 固化；测试计划 → Task 1/2/3 各 Step；文档+版本 → Task 4；mock 盲区/真机验证 → Task 5。无缺口。

**Type consistency：** `gridShape(n): number[]`（Task 1 定义、Task 3 使用）；`launcherScriptFor/launcherScriptContent`（Task 2 定义、Task 3 复用同一实现与测试）；`buildWtArgs(specs, psHost, scriptFiles)` 新签名仅 Task 3 内部与测试引用；`runWt(specs, psHost)` 签名不变故 `runLaunch` 零改动。

**构造序列正确性核对：** k=6 → counts=[2,2,2]，列切 0.6667/0.5000，行切 0.5000×3，move-focus×2，构造顺序 s1,s3,s5,s6,s4,s2；k=5 → [2,2,1]，顺序 s1,s3,s5,s4,s2（与测试断言一致）；k=2 → [1,1]，无行切无 move-focus（guard：左侧无多格列时不发 move-focus）。
