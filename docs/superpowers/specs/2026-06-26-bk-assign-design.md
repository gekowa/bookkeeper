# `bk assign <N>` 设计文档

- 日期：2026-06-26
- 状态：已确认设计，待实现
- 关联：`bk allocate` / `bk deallocate`（`src/cli/commands/allocate.ts`）

## 目标

新增 `bk assign <N>` 命令：**显式指定**当前 worktree 绑定到池子里**已存在的**第 N 套资源。

它是 `allocate` 的"点名认领"版本。`allocate` 负责**无中生有**（自动挑最小空闲号，没有就当场创建）；`assign` 负责**点名拿回**（精确复用一套已知编号的旧资源），二者职责互补。

### 主场景

恢复一个删过又重建的 worktree：你记得它之前用的是第 3 套（`foo_3`，库里数据还在），用 `bk assign 3` 精确把这套资源（端口、库、桶、key 前缀）拿回来、重写 `.env`，而不是听任 `allocate` 给你随机挑一个号。

## 核心原则：严格只复用，绝不创建

`assign` **永不创建新资源**。创建是 `allocate` 的天职；`assign` 的契约是"认领已存在的"。

这条原则的动机：避免"假恢复"陷阱——你以为在恢复第 3 套的旧数据，但它其实早被 `destroy` 了，于是默默给你建了一套**全新的空库**，串到一半才发现。`assign` 宁可报错让你核对编号，也不冒这个险。

> 命令形态权衡（已决策）：曾考虑做成 `allocate [N]` 可选参数，但 `allocate` 的天性是"创建即用"，而 `assign` 的语义是"严格只复用、绝不创建"——二者相反。塞进同一命令会让 `allocate N` 的行为随参数有无在"创建 vs 报错"间分裂。故保留 `assign` 为独立命令，用命令名承载不同契约。

## 在整体模型中的位置：绑定 + 就绪

`assign` 不是孤立特性。"给一个 worktree 配齐资源"本就分两个正交步骤，`assign` 落在第一步：

```
步骤 1【绑定】 决定这个 worktree 占第几套 N + 写 .env
        ├─ bk allocate      自动选号（池里没有就新建）
        └─ bk assign <N>    点名选号（只复用，不新建）   ← 本特性
                                ↓ 绑定后自动跟一步
步骤 2【就绪】 跑 service 的 post_allocate 钩子让工作目录 ready（migrate / seed / npm install）
        ├─（allocate / assign 绑定后自动跑一遍）
        └─ bk setup         单独重跑（绑定不变，只补跑步骤 2）

bk deallocate  = 解绑（步骤 1 的逆操作，资源退回池子）
```

要点：
- **`allocate` 与 `assign` 是"绑定"的两种入口**（自动选号 / 点名选号），共享同一套"绑定后写 `.env` → 跑钩子"的下游逻辑。
- **`post_allocate` 钩子命名的是"绑定完成"这个生命周期时刻，而非某条命令**——它已被 `allocate`、`worktree create`、`bk setup` 三处触发，`assign` 是第四个入口。沿用此名不引入新概念（本次**不改钩子名**，命令形态权衡见上）。
- "绑定（bind）"是描述步骤 1 的**概念词**，不做成独立命令（做了就与 allocate / assign 重复）。

## 行为矩阵

设当前目录为 `cwd`，参数为编号 `N`：

| 第 N 套的状态 | 当前 worktree 状态 | 默认行为 | `--force` |
|---|---|---|---|
| **不存在**（state 无第 N 套记录） | 任意 | ❌ 报错 `SET_NOT_FOUND` | 同左（force 不创建） |
| **free**（池中空闲） | 未分配 | ✅ 绑定 N → 写 `.env`（复用，信任快照不探活） | 同左 |
| **free** | 已绑别的 M（M≠N） | ❌ 报错 `ALREADY_ALLOCATED` | ✅ M 退回池子 → 绑 N → 写 `.env` |
| **allocated 给当前 cwd**（即 N 本身） | 即 N | ✅ 幂等：提示已绑 N、打印资源清单、**不重写** `.env` | 同左 |
| **allocated 给别的 worktree** | 任意 | ❌ 报错 `SET_IN_USE` | ❌ 同左（force 也不抢别人的） |

### 决策要点

1. **N 不存在 → 报错**，`--force` 也不创建。严格符合主场景。
2. **当前目录已绑别的 M** → 默认 `ALREADY_ALLOCATED` 报错；`--force` 执行换绑：先 `deallocate` M（M 退回池子、清掉 M 的 `.env` 标记块、数据保留），再绑 N。
3. **N 被别的 worktree 占用** → **无条件** `SET_IN_USE`，`--force` 也拒绝。理由：抢占会让那个 worktree 的 `.env` 与真实归属脱节、引发看不见的串库事故；动别人 worktree 的副作用超出 `assign --force`（仅针对"动我自己当前目录的绑定"）的范畴。
4. **幂等命中（已绑 N）** → 与 `allocate` 同目录二次执行一致：打印现有资源，不重写 `.env`。

## 不探活、不 provision；但照常跑钩子

区分两类动作：**碰真实基础设施**的（探活、provision）`assign` 不做；**让当前工作目录 ready**的（钩子）照常做。

- **不探活、不 provision**：第 N 套的库/桶早已存在（数据还在），`assign` 只走"复用已存在 free set"路径，与 `allocate` 的 reuse 分支一致——信任 state 快照、不再探活，更不重建资源。
- **照常跑 `post_allocate` 钩子**：钩子的真实触发口径是 **`reused === false`**（本次实际写了 `.env`、把资源绑到当前目录），**与是否 provision 无关**——现有 `allocate` 复用池中空闲号（未 provision）时同样会跑钩子（`doAllocate` 的 pool-reuse 分支返回 `reused: false`）。原因：钩子（`npm install` / `migrate` / `seed`）面向的是**当前工作目录**，而 `assign` 的主场景恰恰是"刚重建、尚未 ready 的新 worktree"——`node_modules` 还没装、依赖还没拉。资源可复用 ≠ 工作目录就绪，所以钩子必须跑。
  - **幂等命中（已绑 N）不跑**：与 `allocate` 一致——当前目录早已绑 N、环境早就绪过，不重复 migrate/seed/install。
  - **提供 `--no-hook`**：与 `allocate` 对齐，需要"绑了但暂不初始化"时用。
  - 关于 `migrate`/`seed` 对已有数据的影响：这与现有 `allocate` 复用空闲号时的情形完全相同（项目的钩子本就需容忍重跑），`assign` 不引入新风险。

## CLI 形态

```
bk assign <N>             # 把当前 worktree 绑定到第 N 套（必须已存在且空闲）
bk assign <N> --force     # 若当前目录已绑别的号，先解绑再绑 N
bk assign <N> --no-hook   # 绑定但不跑 post_allocate 钩子
```

- 位置参数 `<N>`：必填，正整数（≥1）。非正整数或非数字 → `CONFIG_INVALID`（或就地参数校验报错）。
- `--force`：仅放宽"当前目录已绑别的 M"这一条；对"N 被别的 worktree 占用""N 不存在"无效。
- `--no-hook`：跳过 `post_allocate` 钩子，与 `allocate` 对齐。
- 输出风格沿用 `src/cli/output.ts`（`success` / `info` / `plain` + `renderSet`）：
  - 绑定成功：`✓ 已将当前 worktree 绑定到 Set N，并写入 .env`
  - 换绑成功：`✓ Set M 已退回池子，当前 worktree 改绑 Set N，并重写 .env`
  - 幂等命中：`  当前 worktree 已绑定 Set N` + `renderSet` 资源清单
- owner 记录的 `branch` 字段沿用 `allocate` 的 `'(manual)'`。

## 实现要点

新增 `registerAssign(program)`，在 `src/cli/index.ts` 注册（紧挨 `registerAllocate`）。建议与 `allocate` 同文件或新建 `src/cli/commands/assign.ts`，复用既有积木：

- `withState(project_name, fn)`：持锁读改写 state（`src/state/store.js`）。
- `findSetByWorktree(state, cwd)`：判断当前目录是否已绑某套（`src/core/deallocator.js`）。
- `deallocateInState(state, n)` + `removeServiceEnvs(ctx, cwd)`：`--force` 换绑时退回旧的 M、清其 `.env`。
- `planNames(providers, ctx, n)` + `writeServiceEnvs(ctx, cwd, names)`：为 N 重算资源名并写 `.env`（复用 `allocate.ts` 已导出的 `writeServiceEnvs`/`buildDirEnvs`）。
- `runPostAllocate(ctx, cwd, buildDirEnvs(ctx, names), N)`：实际绑定后跑钩子（复用 `src/hooks/postAllocate.js`），在持锁的 `withState` 之外、`.env` 写好之后执行——与 `doAllocate` 的时序完全一致。
- 复用 `activeProviders(ctx)` 得到 provider 列表用于 `planNames`。

核心控制流——绑定决策在持锁的 `withState` 内，钩子在锁外（仿照 `doAllocate`）：

```
// —— withState 内 ——
existing = findSetByWorktree(state, cwd)
target   = state.sets[String(N)]

if !target:                      → throw SET_NOT_FOUND
if target.status == 'allocated':
    if target.owner.worktree == cwd:   → return { reused: true }   // 幂等：不写 .env、不跑钩子
    else:                              → throw SET_IN_USE
// 此处 target 必为 free
if existing && existing != String(N):
    if !force:                   → throw ALREADY_ALLOCATED
    else: deallocateInState(state, existing); removeServiceEnvs(ctx, cwd)
// 绑定 N（复活既有 free SetRecord，保留 resources/created_at，仅翻 status + 写 owner）
target.status = 'allocated'
target.owner  = { worktree: cwd, branch: '(manual)' }
names = planNames(providers, ctx, N)
writeServiceEnvs(ctx, cwd, names)
ensureGitignore(projectRoot, ['.env'])
return { reused: false, names }

// —— withState 外 ——
if !reused && !opts.noHook:
    runPostAllocate(ctx, cwd, buildDirEnvs(ctx, names), N)
```

> 注：复用 free set 时直接复活既有 `SetRecord`（保留其 `resources`/`created_at`），无需 `buildSetRecord` 重建；仅翻转 `status` 并写 `owner`。`names` 由 `planNames` 按 N 重算，仅用于写 `.env` 与喂钩子，与 state 中 `resources` 一致（同一 N 推导同名）。钩子触发口径 `!reused` 与 `doAllocate` 一字不差。

## 新增错误码

在 `src/core/errors.ts` 的 `Codes` 补充：

| Code | 含义 | remediation |
|---|---|---|
| `SET_NOT_FOUND` | 第 N 套不存在（记错号或已被 destroy） | 用 `bk list` 核对现有编号；如需新资源用 `bk allocate` |
| `ALREADY_ALLOCATED` | 当前 worktree 已绑别的号 | 先 `bk deallocate`，或加 `--force` 换绑 |

`SET_IN_USE` 已存在，复用之（语义：编号被别处占用）。

## 测试

新增 `tests/cli/assign.flow.test.ts`，沿用 `allocate.flow.test.ts` 的脚手架（`BK_HOME` 临时目录、`fakeProvider`、`createPortProvider`）。覆盖行为矩阵每一格：

1. **free + 当前未分配** → 绑定成功，state 翻 `allocated`、owner.worktree=cwd，`.env` 写出标记块。
2. **N 不存在** → 抛 `SET_NOT_FOUND`，state 不变、无 `.env`。
3. **已绑 N（幂等）** → 返回 reused、不重写 `.env`、不新增 set。
4. **N 被别的 worktree 占用** → 抛 `SET_IN_USE`（含 `--force` 也抛）。
5. **当前目录已绑 M（M≠N），N 为 free**：
   - 默认 → 抛 `ALREADY_ALLOCATED`，M 仍 allocated、N 仍 free。
   - `--force` → M 退回池子（status free、owner null、M 的 `.env` 块清除）、N 绑到 cwd、`.env` 重写。
6. **钩子时序**：
   - 绑定成功（free → cwd）→ `runPostAllocate` 被调用一次（断言被调、且在 `.env` 写好之后）。
   - 幂等命中（已绑 N）→ 钩子**不被**调用。
   - `--no-hook` → 即便实际绑定，钩子也不被调用。

## 文档

- README「换资源 / 迟分配」小节（现列 `allocate`/`deallocate`）补 `bk assign <N>` 及 `--force`，点明"只复用、不创建"与主场景。
- CHANGELOG 新增条目（下一个版本号）。

## 不做（YAGNI）

- 不支持 `assign` 创建新号（那是 `allocate`）。
- 不支持抢占别的 worktree 占用的号（无 `--steal`）。
- 不支持一次 `assign` 多个号 / 范围。
- 不探活、不 provision（资源已存在）。
