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

## 不探活、不跑钩子

- **不探活**：`assign` 只走"复用已存在 free set"路径，与 `allocate` 的 reuse 分支一致——信任 state 快照、不再对端口/库做真实世界探活（`allocator.resolveSet` 的 `reuse` 早返回即此语义）。
- **不跑 `post_allocate` 钩子**：钩子的契约是"仅在实际 provision 出新资源时跑"（见 post-allocate-hook 设计）。`assign` 从不 provision，故**永远不触发钩子**，也因此**不需要** `--no-hook` flag。被恢复的资源数据还在，本就不该重跑 migration/seed。

## CLI 形态

```
bk assign <N>            # 把当前 worktree 绑定到第 N 套（必须已存在且空闲）
bk assign <N> --force    # 若当前目录已绑别的号，先解绑再绑 N
```

- 位置参数 `<N>`：必填，正整数（≥1）。非正整数或非数字 → `CONFIG_INVALID`（或就地参数校验报错）。
- `--force`：仅放宽"当前目录已绑别的 M"这一条；对"N 被别的 worktree 占用""N 不存在"无效。
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
- 复用 `activeProviders(ctx)` 得到 provider 列表用于 `planNames`。

核心控制流（持锁的 `withState` 内）：

```
existing = findSetByWorktree(state, cwd)
target   = state.sets[String(N)]

if !target:                      → throw SET_NOT_FOUND
if target.status == 'allocated':
    if target.owner.worktree == cwd:   → 幂等返回（不写 .env）
    else:                              → throw SET_IN_USE
// 此处 target 必为 free
if existing && existing != String(N):
    if !force:                   → throw ALREADY_ALLOCATED
    else: deallocateInState(state, existing); removeServiceEnvs(ctx, cwd)
// 绑定 N
target.status = 'allocated'
target.owner  = { worktree: cwd, branch: '(manual)' }
names = planNames(providers, ctx, N)
writeServiceEnvs(ctx, cwd, names)
ensureGitignore(projectRoot, ['.env'])
```

> 注：复用 free set 时直接复活既有 `SetRecord`（保留其 `resources`/`created_at`），无需 `buildSetRecord` 重建；仅翻转 `status` 并写 `owner`。`names` 由 `planNames` 按 N 重算，仅用于写 `.env`，与 state 中 `resources` 一致（同一 N 推导同名）。

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
6. **不跑钩子**：assign 路径不调用 `runPostAllocate`（可通过断言钩子未被调用，或依"从不 provision"逻辑覆盖）。

## 文档

- README「换资源 / 迟分配」小节（现列 `allocate`/`deallocate`）补 `bk assign <N>` 及 `--force`，点明"只复用、不创建"与主场景。
- CHANGELOG 新增条目（下一个版本号）。

## 不做（YAGNI）

- 不支持 `assign` 创建新号（那是 `allocate`）。
- 不支持抢占别的 worktree 占用的号（无 `--steal`）。
- 不支持一次 `assign` 多个号 / 范围。
- 不探活、不加 `--no-hook`（钩子永不触发）。
