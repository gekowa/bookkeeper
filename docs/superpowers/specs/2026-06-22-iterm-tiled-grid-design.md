# iTerm 均匀网格启动设计

## 背景与问题

`src/launch/iterm.ts` 当前对每个 service 都在「当前 session」上执行 `split vertically`，
即把当前这一格垂直对半切。结果第 2 个 service 占右半，第 3 个再把右半对半……
service 越多 pane 越窄、且左右不均：

```
2 个:  [  A  ][  B  ]      ← 还算均匀
3 个:  [  A  ][ B ][C]     ← B、C 越来越窄
4 个:  [ A ][B][C][D]      ← 挤成竖条
```

相邻的 `src/launch/tmux.ts` 早已用 `select-layout tiled` 一键摊成均匀网格，
iTerm 这边缺的就是这个「摊平」动作。但 iTerm2 的 AppleScript `split` 命令只能把目标
pane **对半切**，没有可靠的「设定 pane 尺寸」能力，因此需要在「只能对半切」的约束下
自己算出最优均匀的网格。

## 约束

- **纯 AppleScript / 零新依赖**：不引入 iTerm2 Python API 或其它 runtime。
- iTerm `split` 只能对半切目标 pane：
  - `split vertically` 在目标右侧新建 pane 并返回新 session；
  - `split horizontally` 在目标下方新建 pane 并返回新 session。
- 因此「严格等分」仅在 2 的幂数量下可得；3/5/6 等数量下，最优也只能做到
  最大格 : 最小格 ≤ 2:1。这是已接受的取舍（方案 A：平衡二分网格，零依赖，
  与 tmux 路径对称）。

## 核心算法：「永远切最大的那格」

不用朴素的「逐个往右切」（连 4 格都会切歪成 .5/.25/.125/.125），改用**二分最大段**——
这是在「只能对半切」约束下能达到的最优均匀，逻辑上等价于 tmux 的 tiled。

1. **网格维度**：`cols = ceil(√N)`，`rows = ceil(N / cols)`。
2. **每列格数（列优先填充）**：`f = N − cols·(rows−1)` 列放满 `rows` 格，
   其余列放 `rows−1` 格，**满的列排在前面**。
3. **建列**：从窗口唯一 session 出发，要凑够 `cols` 列，就反复对**当前最宽的段**做
   垂直切，记录每次 split 的目标段与新生成的段。
4. **建行**：在每个列顶 session 内，同样反复对**当前最高的段**做水平切，凑够该列行数。
5. **写命令**：按列优先顺序（col0 上→下，col1 上→下……）把 `specs[i]` 的
   `cd <cwd> && <command>` 写进第 i 个 pane。

### 「切最大段」如何保证最优均匀

维护一个段列表 `{ id, size }`，`size` 仅用于挑选目标、不下发给 iTerm。
每次取 `size` 最大的段对半切：把该段替换为两个各半大小的段（垂直切时新段在右、
水平切时新段在下）。

- cols=2 → `.5 / .5`（等分）
- cols=3 → `.5 / .5` → 切其一 → `.25 / .25 / .5`（≤2:1）
- cols=4 → `.5 / .5` → `.25 / .25 / .5` → `.25 / .25 / .25 / .25`（等分）

### 各 N 的效果

| N | cols×rows | 布局 | 均匀度 |
|---|-----------|------|--------|
| 1 | 1×1 | 单格 | — |
| 2 | 2×1 | `[A][B]` | 严格等分 |
| 3 | 2×2 | `[A][C] / [B][C]` | 列宽等分；右列单格 2× 高（≤2:1）|
| 4 | 2×2 | 2×2 | 严格等分 |
| 5 | 3×2 | 列宽 .25/.25/.5 | ≤2:1 |
| 6 | 3×2 | 列宽 .5/.25/.25 | ≤2:1 |
| 8 | 3×3 | — | 列宽 ≤2:1 |

**评价口径**：均匀度按「列宽比」与「列内行高比」衡量，二者 ≤ 2:1。
严格等分（所有 pane 等大）仅在 `cols=ceil(√N)` 为 2 的幂且网格填满时成立，
即 N ∈ {1, 2, 4, 16, …}。N=3 时左列两格各 `.5×.5`、右列单格 `.5×1.0`，
右列 pane 是左列的 2 倍高——这是「只能对半切」下 3 格能达到的最优，无法真正等分。

## 代码结构

贴合现有「纯函数 core + 薄 IO」风格：几何计算抽成纯函数便于单测，
`runIterm` 仍是薄薄的 osascript 外壳。

### 新增 `src/launch/itermGrid.ts`（纯函数）

```ts
export type SplitDir = 'v' | 'h'
export interface SplitStep { target: number; dir: SplitDir; next: number }
export interface GridPlan {
  paneCount: number       // = N
  steps: SplitStep[]      // 有序 split 步骤；target/next 为段下标（0 = 首个 session）
}
export function planGrid(n: number): GridPlan
```

- 只吃数量 `n`，吐出有序 split 步骤；**不碰 AppleScript**。
- 内部用 `{ id, size }` 段列表模拟「切最大段」，`size` 仅用于挑目标。
- `steps` 的 `target` 指向已存在的段下标，`next` 是本次新建段被分配的下标。
- 最终 pane 顺序即段下标 `0..n-1`，按列优先对应布局位置。

### 改写 `src/launch/iterm.ts`

- 调 `planGrid(specs.length)` 拿步骤。
- 生成 AppleScript：用 `s0…s{N-1}` 变量名持有 session 引用，
  `tell s{target}` 内 `set s{next} to (split <vertically|horizontally> with default profile)`，
  再对每个 `s{i}` `write text "cd <cwd> && <command>"`（命令里的 `"` 转义保持现状）。
- `specs.length === 0` 直接 return（对齐 `tmux.ts`）；`N === 1` 不分屏、只写命令。
- 通过 `osascript` 执行（沿用现有 `execa('osascript', lines.flatMap(...))` 方式）。

### 不变的部分

`selectStrategy`、`buildLaunchSpecs`、`LaunchSpec` 类型、tmux/print 路径、
CLI 全部不变。这是一次纯局部替换。

## 测试

新增 `tests/launch/itermGrid.test.ts`，对 `planGrid` 做纯几何断言（不跑 osascript）：

- pane 总数恒等于 N（`paneCount === n`，且 steps 产生的段总数 = n）。
- **均匀度**：在 JS 里按 steps 模拟执行（对半切目标段、重建各 pane 的宽/高分数），
  断言最大:最小比 ≤ 2；N ∈ {1,2,4} 时应严格 = 1。
- 边界：N=0（空 steps）、N=1（空 steps、单 pane）。
- pane 顺序与列优先布局一致（段下标 0..n-1 落在预期的列/行位置）。

`iterm.ts` 的 osascript 字符串拼接保持薄、不单测（与现状一致）。

## 验收标准

- 在 iTerm2 下启动 3 个 service，得到 `[A][C] / [B][C]` 等大网格，不再出现窄竖条。
- `planGrid` 单测全绿，N≤4 严格等分、其余 ≤2:1。
- tmux / print 路径行为不变；现有测试全绿。
