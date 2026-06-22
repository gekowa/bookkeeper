# post_allocate 钩子（分配就绪后跑自定义 setup 命令）

- 日期：2026-06-22
- 状态：设计已批准，待写实现计划

## 背景与问题

`bk worktree create` 的主路径是 `git worktree add → allocate → 写 .env`，返回那一刻 `.env` 已写好且指向正确的库。README 明确声明 **「migrate/seed 何时跑由你决定，bk 不代劳」**——bk 管资源的存在与归属，不管资源的内容（建表、灌种子、装依赖全是项目自己的事）。

实际使用中，每次新建 worktree 后都要手动重复一串环境就绪命令：后端 `uv run migrate && seed`、前端 `npm install`。这件事 bk 不想「懂」，但可以提供一个**触发点**：在分配就绪后，忠实地替你跑一条你自己配置的命令。bk 仍然不理解 migrate/seed 的语义，只负责在正确时机（`.env` 已写好）触发，并如实报告结果。

本质：给 allocate 流程加一个 per-service 的 `post_allocate` 钩子，让「环境就绪」从「`.env` 写好」延伸到「依赖装好、库迁移好」。

## 核心决策（来自 brainstorming）

1. **粒度 per-service**：复用现有 `dir` / `bk start` 心智——每条钩子在该 service 的 `dir` 下运行，零新概念。
2. **字段名 `post_allocate`**：钩子真正绑定的事件是「**分配完成、`.env` 就绪**」，不是「worktree 创建」本身。`bk worktree create` 内部也是靠 allocate 让环境就绪。`post_allocate` 名实最诚实，且让「worktree create / allocate / setup 三处触发」自然统一。
3. **标量字符串**：单条命令，多步靠 `&&` 自串；不做列表形态（符合项目「砍配置形态」风格）。
4. **走 `sh -c`**：`$BK_DB_NAME`、`&&`、管道、重定向都能用。
5. **注入 `BK_*` + `BK_N`**：跑钩子时把该 service 目录对应的 `BK_*`（与写进 `.env` 的同一批）+ `BK_N` 塞进进程环境变量。
6. **失败不回滚、fail-fast、可重跑**：钩子失败属于「你的命令内容出错」，资源本身干净可用，回滚反而误删好 worktree。停在出错处，保留现场，修完用 `bk setup` 重跑。

## 设计

### 1. 新增配置字段 `post_allocate`

每个 service 可选 `post_allocate?: string`（标量，单条 shell 命令）。

```yaml
services:
  backend:
    type: django
    port_base: 10000
    dir: backend
    post_allocate: uv run python manage.py migrate && uv run python manage.py seed
  frontend:
    type: vite
    port_base: 10100
    dir: frontend
    post_allocate: npm install
```

- `src/core/types.ts` 的 `ServiceConfig` 增加 `post_allocate?: string`。
- `src/config/load.ts` 在 map→数组时透传 `post_allocate`。
- 没写 `post_allocate` 的 service 静默跳过，不报错。

### 2. 触发时机

钩子在**每次 allocate 成功落地（`.env` 写好）之后**跑：

- `bk worktree create <branch>`：建 worktree → allocate → 写 `.env` → **跑 `post_allocate`**（主路径）。
- `bk allocate`（手动迟分配）：allocate → 写 `.env` → **跑 `post_allocate`**（语义等价）。
- **幂等命中已有资源时不跑**：`doAllocate` 当前对「当前目录已分配」直接返回既有 Set（`reused: true`），此时**不重复跑钩子**（环境早已就绪过，不应再 migrate/seed/install 一遍）。
- `--no-hook` 旗标（见第 5 节）跳过钩子。

判定口径：**仅当本次 allocate 实际写了 `.env`（`reused === false`）时才跑钩子。**

### 3. 执行语义（per-service 串行）

按 config 中 services 声明顺序，对每个**写了 `post_allocate`** 的 service：

1. **工作目录**：`<worktreeDir>/<service.dir>`（`dir` 缺省为 worktree 根 `.`）。
2. **执行方式**：`sh -c "<post_allocate>"`，继承当前进程环境，叠加注入的 `BK_*` + `BK_N`（见第 4 节）。
3. **fail-fast**：某 service 钩子退出码非 0 → **立即停止**，不再跑后面的 service，向上抛错。
4. stdout/stderr **直通**到用户终端（钩子是用户的命令，输出应当可见，便于排查）。

> 注：同目录多 service（如 backend + 同 `dir` 的 arq worker）各自的 `post_allocate` 独立成条、各跑各的（与第 3 节顺序规则一致）。通常 worker 不单独写 `post_allocate`（migrate 一次即可）；若写了也照跑。这与 `.env` 注入「按目录合并」不同——钩子是**命令**，不做去重合并。

### 4. 环境变量注入

跑某 service 的钩子前，构造其进程 env = `process.env` 叠加：

- 该 service 目录对应的那批 `BK_*` 变量——**复用现有 `buildDirEnvs(ctx, names)` 的产出**（即写进该目录 `.env` 的同一批值），保证名实一致、无新语义。
- `BK_N`：资源集编号（整数，如 `2`）。

实现上从 `doAllocate` 已算好的 `names: ResourceNames` 派生，零额外计算。

### 5. 失败处理

- **不回滚**：钩子失败时 worktree、资源、`.env` 全部保留。allocate 自身的回滚逻辑（provision 失败删孤儿资源）**不受影响、维持原样**——钩子在 `doAllocate` 的 state 事务/回滚之外、`.env` 写好之后执行。
- **fail-fast**：停在出错的那个 service。
- **如实报告**：错误信息点明「service `<name>` 的 post_allocate 失败（exit code N），命令：`<cmd>`，工作目录：`<dir>`」，并提示「修复后用 `bk setup` 重跑」。
- **退出码**：`bk worktree create` / `bk allocate` 以非 0 退出，便于脚本/AI 感知。
- **现场可重跑**：worktree 与资源已就绪，修好脚本后 `bk setup` 即可重跑，无需重建。

### 6. 新命令 `bk setup`

- `bk setup`（无参）：对**当前 worktree** 重跑所有 service 的 `post_allocate`。
- 用途：钩子失败修复后重跑；或单独重建 `node_modules`、补跑新加的 migration。
- 前置：当前目录必须是已分配资源的 worktree（能 `findSetByWorktree` 命中）；否则报「当前 worktree 未分配资源，先 `bk allocate`」。
- 复用第 3/4 节同一套执行 + 注入 + fail-fast 逻辑（从 state 里既有 Set 派生 `names`，不重新分配）。

### 7. `--no-hook` 旗标

- `bk worktree create <branch> --no-hook`：建 worktree + allocate + 写 `.env`，但**不跑钩子**（同 `--no-allocate` 风格）。
- `bk allocate --no-hook`：同理。
- `--no-allocate` 已隐含不跑钩子（没 allocate 就没有「分配就绪」事件）；两旗标可叠加但 `--no-allocate` 时 `--no-hook` 无额外效果。

## 影响的文件（预估）

- `src/core/types.ts`：`ServiceConfig.post_allocate?: string`
- `src/config/load.ts`：透传 `post_allocate`
- 新建 `src/hooks/postAllocate.ts`（或并入 `src/cli/commands/allocate.ts`）：per-service 串行执行 + env 注入 + fail-fast 的核心函数，签名示意 `runPostAllocate(ctx, worktreeDir, names): Promise<void>`
- `src/cli/commands/allocate.ts`：`doAllocate` 成功且 `reused === false` 后调用钩子（受 `--no-hook` 控制）；`allocate` 命令注册 `--no-hook`
- `src/cli/commands/worktree.ts`：`createWorktree` 透传 `--no-hook`；`create` 命令注册 `--no-hook`
- 新建 `src/cli/commands/setup.ts`：`bk setup` 命令，从既有 Set 派生 `names` 后重跑钩子
- `src/cli/index.ts`：注册 `setup` 命令
- `README.md`：新增 `post_allocate` 字段说明、`bk setup` 命令、`--no-hook` 旗标；更新「migrate/seed 由你决定」一节，说明钩子作为可选自动化触发点

## 测试

- **配置加载**：`post_allocate` 标量透传；缺省为 undefined。
- **执行**：钩子在正确的 `dir` 下运行（断言 cwd）；`sh -c` 能解析 `&&` 与 `$BK_DB_NAME`。
- **env 注入**：钩子进程能读到该目录的 `BK_*` + `BK_N`；前端目录注入的是前端那批（不含后端 `BK_DB_NAME`）。
- **触发时机**：`worktree create` / `allocate` 跑钩子；幂等命中（`reused`）**不跑**；`--no-hook` 跳过。
- **fail-fast**：第一个 service 钩子失败 → 第二个不执行；命令非 0 退出；worktree/资源/`.env` 保留（断言未回滚）。
- **`bk setup`**：未分配 worktree 报错；已分配则重跑全部钩子；从既有 Set 正确派生 `names`。
- **回归**：现有 `tests/cli/allocate.flow.test.ts`、worktree 相关测试适配（默认现在多跑钩子；测试 fixture 的 config 不写 `post_allocate` 则行为不变）。

## 非目标（YAGNI）

- 列表形态 / 多条命令数组（用 `&&` 串）。
- 其他生命周期钩子（`pre_allocate`、`post_deallocate`、`post_destroy` 等）——只做 `post_allocate`。
- 钩子超时、重试、并行执行——串行、不限时、失败即停。
- 钩子失败时回滚资源——明确不做。
- 把 `BK_*` 之外的任意自定义变量注入钩子环境——只注入既有的 `BK_*` + `BK_N`。
