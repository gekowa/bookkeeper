# iTerm 均匀网格启动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 iTerm 启动从"逐个垂直对半切"换成均匀网格布局，service 增多时 pane 不再越来越窄。

**Architecture:** 新增纯函数 `planGrid(n)` 用「切最大段」算法算出网格的 split 步骤与 pane→spec 映射；新增纯函数 `buildItermScript(specs, plan)` 把步骤渲染成 AppleScript 行；`runIterm` 退化成只负责调 `osascript` 的薄壳。几何与字符串拼接都可单测，IO 不测。

**Tech Stack:** TypeScript (ESM, `.js` 后缀导入)、vitest、execa、osascript（macOS / iTerm2）。

## Global Constraints

- ESM 项目：源码内相对导入必须带 `.js` 后缀（如 `'./itermGrid.js'`），测试导入源码用 `'../../src/.../x.js'`。
- 测试用显式导入（`vitest.config.ts` 里 `globals: false`）：每个测试文件顶部 `import { describe, it, expect } from 'vitest'`。
- 测试文件放 `tests/**/*.test.ts`，运行命令统一 `npx vitest run <path>`。
- 不引入任何新依赖（零依赖约束）。
- `runIterm` 的 osascript 拼接保持薄、不单测；可测逻辑全部抽成纯函数。
- 中文注释风格与现有代码一致（简短、说明"为什么"）。

---

### Task 1: `planGrid` 网格几何（纯函数）

**Files:**
- Create: `src/launch/itermGrid.ts`
- Test: `tests/launch/itermGrid.test.ts`

**Interfaces:**
- Consumes: 无（只吃一个数字 `n`）。
- Produces:
  ```ts
  export type SplitDir = 'v' | 'h'
  export interface SplitStep { target: number; dir: SplitDir; next: number }
  export interface GridPlan {
    paneCount: number   // = max(0, n)
    steps: SplitStep[]  // 有序 split 步骤；target/next 为 session 下标（0 = 首个 session）
    order: number[]     // order[k] = 第 k 个 service 应写入的 session 下标（列优先）
  }
  export function planGrid(n: number): GridPlan
  ```
  语义：从 1 个 session（下标 0）出发，依次执行 `steps`——每步对 `target` 这个 session 按 `dir` 方向对半切，新 session 拿到下标 `next`（垂直切时在右、水平切时在下）。`next` 恒为 `1,2,…,n-1` 递增。`order` 把 0..n-1 的 session 按"列优先（先列后行、列内自上而下）"重排，用于给第 k 个 service 指定落在哪个 session。

- [ ] **Step 1: 写失败测试**

创建 `tests/launch/itermGrid.test.ts`。测试里自带一个几何模拟器：按 `steps` 把每个 session 的矩形 `{x,y,w,h}` 切出来，再断言均匀度与映射正确。

```ts
// tests/launch/itermGrid.test.ts
import { describe, it, expect } from 'vitest'
import { planGrid, type GridPlan } from '../../src/launch/itermGrid.js'

// 按 steps 模拟分屏，重建每个 session 的矩形（窗口归一化到 1×1）
function simulate(plan: GridPlan): Map<number, { x: number; y: number; w: number; h: number }> {
  const rect = new Map<number, { x: number; y: number; w: number; h: number }>()
  if (plan.paneCount >= 1) rect.set(0, { x: 0, y: 0, w: 1, h: 1 })
  for (const s of plan.steps) {
    const r = rect.get(s.target)!
    if (s.dir === 'v') {
      rect.set(s.target, { ...r, w: r.w / 2 })
      rect.set(s.next, { x: r.x + r.w / 2, y: r.y, w: r.w / 2, h: r.h })
    } else {
      rect.set(s.target, { ...r, h: r.h / 2 })
      rect.set(s.next, { x: r.x, y: r.y + r.h / 2, w: r.w, h: r.h / 2 })
    }
  }
  return rect
}

function ratio(values: number[]): number {
  return Math.max(...values) / Math.min(...values)
}

describe('planGrid 边界', () => {
  it('n<=0 → 空计划', () => {
    expect(planGrid(0)).toEqual({ paneCount: 0, steps: [], order: [] })
    expect(planGrid(-3)).toEqual({ paneCount: 0, steps: [], order: [] })
  })
  it('n=1 → 单 pane 无 split', () => {
    expect(planGrid(1)).toEqual({ paneCount: 1, steps: [], order: [0] })
  })
})

describe('planGrid 结构不变量', () => {
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 12]) {
    it(`n=${n}: pane 数、step 数、order 是 0..n-1 的排列`, () => {
      const p = planGrid(n)
      expect(p.paneCount).toBe(n)
      expect(p.steps.length).toBe(n - 1)
      // next 恒为 1..n-1 递增
      expect(p.steps.map(s => s.next)).toEqual(Array.from({ length: n - 1 }, (_, i) => i + 1))
      // 每个 target 在它出现前必须已存在（0 或更早的 next）
      const seen = new Set([0])
      for (const s of p.steps) { expect(seen.has(s.target)).toBe(true); seen.add(s.next) }
      // order 是 0..n-1 的排列
      expect([...p.order].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i))
    })
  }
})

describe('planGrid 均匀度（列宽比/行高比 ≤ 2）', () => {
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 12]) {
    it(`n=${n}: 所有 pane 宽比≤2、高比≤2`, () => {
      const p = planGrid(n)
      const rects = [...simulate(p).values()]
      expect(ratio(rects.map(r => r.w))).toBeLessThanOrEqual(2 + 1e-9)
      expect(ratio(rects.map(r => r.h))).toBeLessThanOrEqual(2 + 1e-9)
    })
  }
  for (const n of [1, 2, 4]) {
    it(`n=${n}: 严格等分（所有 pane 等面积）`, () => {
      const rects = [...simulate(planGrid(n)).values()]
      const areas = rects.map(r => r.w * r.h)
      expect(ratio(areas)).toBeCloseTo(1, 9)
    })
  }
})

describe('planGrid 列优先映射', () => {
  it('n=3: order 把 service 落到 左上→左下→右整列', () => {
    const p = planGrid(3)
    const rect = simulate(p)
    const pos = p.order.map(id => rect.get(id)!)
    // service0 左上、service1 左下、service2 右列（x 更大、占满高度）
    expect(pos[0].x).toBeCloseTo(0); expect(pos[0].y).toBeCloseTo(0)
    expect(pos[1].x).toBeCloseTo(0); expect(pos[1].y).toBeCloseTo(0.5)
    expect(pos[2].x).toBeGreaterThan(0); expect(pos[2].h).toBeCloseTo(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/launch/itermGrid.test.ts`
Expected: FAIL —— 解析/导入报错，提示 `planGrid` 不存在（`itermGrid.ts` 尚未创建）。

- [ ] **Step 3: 写最小实现**

创建 `src/launch/itermGrid.ts`：

```ts
// iTerm 均匀网格的几何计算（纯函数，不碰 AppleScript）
export type SplitDir = 'v' | 'h'
export interface SplitStep { target: number; dir: SplitDir; next: number }
export interface GridPlan {
  paneCount: number
  steps: SplitStep[]
  order: number[]
}

interface Seg { id: number; pos: number; size: number } // size 仅用于挑「最大段」，不下发给 iTerm

export function planGrid(n: number): GridPlan {
  if (n <= 0) return { paneCount: 0, steps: [], order: [] }
  if (n === 1) return { paneCount: 1, steps: [], order: [0] }

  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  // 列优先填充：前 fullCols 列放满 rows 格，其余列放 rows-1 格
  const fullCols = n - cols * (rows - 1)
  const colCounts = Array.from({ length: cols }, (_, c) => (c < fullCols ? rows : rows - 1))

  const steps: SplitStep[] = []
  let nextId = 1

  // 把 rootId 这个 session 按「反复切最大段」二分成 count 个，返回子段（按 pos 升序）
  function bisect(rootId: number, count: number, dir: SplitDir): Seg[] {
    const segs: Seg[] = [{ id: rootId, pos: 0, size: 1 }]
    while (segs.length < count) {
      let mi = 0 // 最大段下标（平局取最靠前，保证确定性）
      for (let i = 1; i < segs.length; i++) if (segs[i].size > segs[mi].size + 1e-9) mi = i
      const t = segs[mi]
      const id = nextId++
      steps.push({ target: t.id, dir, next: id })
      const half = t.size / 2 // 新段在「右/下」（pos 更大的一侧）
      segs.splice(mi, 1, { id: t.id, pos: t.pos, size: half }, { id, pos: t.pos + half, size: half })
    }
    return [...segs].sort((a, b) => a.pos - b.pos)
  }

  // 阶段1：建列（垂直切）；阶段2：每列建行（水平切）
  const colSegs = bisect(0, cols, 'v')
  const panes: { col: number; row: number; id: number }[] = []
  colSegs.forEach((cs, col) => {
    bisect(cs.id, colCounts[col], 'h').forEach((rs, row) => panes.push({ col, row, id: rs.id }))
  })

  // 列优先排序 → order[k] = 第 k 个 service 应写入的 session 下标
  panes.sort((a, b) => a.col - b.col || a.row - b.row)
  return { paneCount: n, steps, order: panes.map(p => p.id) }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/launch/itermGrid.test.ts`
Expected: PASS（全部用例绿）。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 6: 提交**

```bash
git add src/launch/itermGrid.ts tests/launch/itermGrid.test.ts
git commit -m "feat(iterm): planGrid 均匀网格几何（切最大段，纯函数 + 测试）"
```

---

### Task 2: `buildItermScript` 渲染 + `runIterm` 改写

**Files:**
- Modify: `src/launch/iterm.ts`（整文件重写）
- Test: `tests/launch/iterm.test.ts`

**Interfaces:**
- Consumes: `planGrid`、`GridPlan`、`SplitStep`（来自 Task 1 的 `./itermGrid.js`）；`LaunchSpec`（来自 `./index.js`，形状 `{ name: string; command: string; cwd: string }`）。
- Produces:
  ```ts
  export function buildItermScript(specs: LaunchSpec[], plan: GridPlan): string[]
  export function runIterm(specs: LaunchSpec[]): Promise<void>
  ```
  `buildItermScript` 返回 AppleScript 的逐行数组（不含 `-e`）；约定：`v`→`split vertically`，`h`→`split horizontally`，命令里的 `"` 转义成 `\"`。`runIterm` 用这些行调 `osascript`，`specs` 为空时直接返回。

- [ ] **Step 1: 写失败测试**

创建 `tests/launch/iterm.test.ts`（只测纯函数 `buildItermScript`，不跑 osascript）：

```ts
// tests/launch/iterm.test.ts
import { describe, it, expect } from 'vitest'
import { buildItermScript } from '../../src/launch/iterm.js'
import { planGrid } from '../../src/launch/itermGrid.js'
import type { LaunchSpec } from '../../src/launch/index.js'

const mk = (n: number): LaunchSpec[] =>
  Array.from({ length: n }, (_, i) => ({ name: `s${i}`, command: `run ${i}`, cwd: `/w/${i}` }))

describe('buildItermScript', () => {
  it('开窗 + 捕获首个 session 为 s0', () => {
    const lines = buildItermScript(mk(2), planGrid(2))
    expect(lines).toContain('tell application "iTerm2"')
    expect(lines).toContain('create window with default profile')
    expect(lines).toContain('set s0 to (current session of current window)')
    expect(lines[lines.length - 1]).toBe('end tell')
  })

  it('每个 split step 渲染成对应方向、并把新 session 存进 s{next}', () => {
    const plan = planGrid(2) // 1 个垂直 split：{target:0,dir:"v",next:1}
    const lines = buildItermScript(mk(2), plan).join('\n')
    expect(lines).toContain('tell s0')
    expect(lines).toContain('set s1 to (split vertically with default profile)')
  })

  it('水平 split 渲染成 split horizontally', () => {
    const plan = planGrid(3) // 含一个 dir:"h" 的 step
    const lines = buildItermScript(mk(3), plan).join('\n')
    expect(lines).toContain('set s2 to (split horizontally with default profile)')
  })

  it('按 order 把第 k 个 service 的命令写进对应 session，且 cd 到 cwd', () => {
    const specs = mk(3)
    const plan = planGrid(3) // order = [0,2,1]
    const lines = buildItermScript(specs, plan)
    // service0 → s{order[0]}=s0
    expect(lines).toContain('tell s0')
    expect(lines).toContain('write text "cd /w/0 && run 0"')
    // service2 → s{order[2]}=s1
    expect(lines).toContain('write text "cd /w/2 && run 2"')
  })

  it('命令与路径中的双引号被转义', () => {
    const specs: LaunchSpec[] = [{ name: 'a', command: 'echo "hi"', cwd: '/w/a b' }]
    const lines = buildItermScript(specs, planGrid(1)).join('\n')
    expect(lines).toContain('write text "cd /w/a b && echo \\"hi\\""')
  })

  it('n=1 不产生任何 split', () => {
    const lines = buildItermScript(mk(1), planGrid(1)).join('\n')
    expect(lines).not.toContain('split ')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/launch/iterm.test.ts`
Expected: FAIL —— `buildItermScript` 未导出（当前 `iterm.ts` 只有 `runIterm`）。

- [ ] **Step 3: 改写实现**

整体重写 `src/launch/iterm.ts`：

```ts
import { execa } from 'execa'
import type { LaunchSpec } from './index.js'
import { planGrid, type GridPlan } from './itermGrid.js'

const esc = (s: string) => s.replace(/"/g, '\\"')

// 把网格计划渲染成 osascript 逐行脚本：先开窗捕获 s0，再按 steps 分屏，最后按 order 写命令
export function buildItermScript(specs: LaunchSpec[], plan: GridPlan): string[] {
  const lines: string[] = [
    'tell application "iTerm2"',
    'create window with default profile',
    'set s0 to (current session of current window)',
  ]
  for (const step of plan.steps) {
    const verb = step.dir === 'v' ? 'split vertically' : 'split horizontally'
    lines.push(`tell s${step.target}`, `set s${step.next} to (${verb} with default profile)`, 'end tell')
  }
  specs.forEach((s, k) => {
    const sid = plan.order[k] // 第 k 个 service 落在哪个 session
    lines.push(`tell s${sid}`, `write text "cd ${esc(s.cwd)} && ${esc(s.command)}"`, 'end tell')
  })
  lines.push('end tell')
  return lines
}

export async function runIterm(specs: LaunchSpec[]): Promise<void> {
  if (!specs.length) return // 对齐 tmux：无 service 不开窗
  const lines = buildItermScript(specs, planGrid(specs.length))
  await execa('osascript', lines.flatMap(l => ['-e', l]))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/launch/iterm.test.ts`
Expected: PASS（全部用例绿）。

- [ ] **Step 5: 全量测试 + 类型检查（确认未回归）**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿、无类型错误。

- [ ] **Step 6: 提交**

```bash
git add src/launch/iterm.ts tests/launch/iterm.test.ts
git commit -m "feat(iterm): 用 planGrid + buildItermScript 渲染均匀网格，runIterm 退化为薄壳"
```

---

### Task 3: 手动验证 + 版本号

**Files:**
- Modify: `package.json`（version bump）

> 本任务无法用单测覆盖（需真实 iTerm2），靠人工目检 + 一次小版本号递增收尾。

- [ ] **Step 1: 真机目检**

在 iTerm2 里准备一个含 3 个 service 的 worktree，运行启动命令（如 `bk start` / 项目对应入口），确认：
- 弹出 1 个新 iTerm 窗口；
- 布局为 `[A][C] / [B][C]`：左列上下两格、右列一格占满整列高度；
- 三个 pane 都执行了正确的 `cd <cwd> && <command>`，宽度不再退化成窄竖条。

若手头能再凑 5/6 个 service，确认列宽呈 2:1 而非逐格减半（非必需）。

- [ ] **Step 2: bump 版本号**

按现有发布习惯（参考最近的 `chore(release): bump x.x.x` 提交）把 `package.json` 的 `version` 递增一个 patch（当前 `0.0.6` → `0.0.7`）。

- [ ] **Step 3: 提交**

```bash
git add package.json
git commit -m "chore(release): bump 0.0.7（iTerm 均匀网格）"
```

---

## Self-Review

**1. Spec coverage（逐节核对 spec → 任务）**
- 核心算法「切最大段」+ cols/rows/fullCols 维度 → Task 1 `planGrid`。✓
- 代码结构「纯函数 planGrid + 薄 IO runIterm」→ Task 1（planGrid）、Task 2（buildItermScript 纯函数 + runIterm 薄壳）。✓
- 边界 N=0 直接 return、N=1 不分屏 → Task 1（planGrid 边界）+ Task 2（runIterm 空 return、buildItermScript n=1 无 split）。✓
- 测试「planGrid 纯几何断言、osascript 不单测」→ Task 1 测试 + Task 2 只测 `buildItermScript`、`runIterm` 不测。✓
- 不变部分（selectStrategy/buildLaunchSpecs/tmux/print）→ 计划未触碰，Task 2 Step 5 全量测试守回归。✓
- 验收标准（3 service 等大网格、N≤4 严格等分、tmux/print 不变）→ Task 1 均匀度测试 + Task 3 真机目检。✓

**2. Placeholder scan：** 无 TBD/TODO；每个代码步骤均有完整代码与确切命令、预期输出。✓

**3. Type consistency：** `SplitStep{target,dir,next}`、`GridPlan{paneCount,steps,order}`、`SplitDir='v'|'h'`、`planGrid(n)`、`buildItermScript(specs,plan)`、`runIterm(specs)`、`LaunchSpec{name,command,cwd}` 在 Task 1/2 定义与使用处签名一致；`order`/`steps`/`paneCount` 字段名跨任务统一。✓
