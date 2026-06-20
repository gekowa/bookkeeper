# BookKeeper 实现设计规格

> 日期：2026-06-20
> 状态：已批准设计，待转入 writing-plans
> 产品层行为以 `README.md` 为准；本文档聚焦**实现架构**。

## 1. 范围与定位

BookKeeper（`bk`）是一个 strongly-opinionated 的 Node/TS CLI，管理并行 git worktree 所需的本地逻辑资源（端口、Postgres 库、Redis 命名空间、MinIO 桶）。

- **职责**：逻辑资源的**存在与归属**——创建/分配/回收/销毁，并记录归属。
- **非职责**：infra 软件进程生命周期、资源内容（migrate/seed）、应用进程生命周期。

产品行为（命令面、资源命名、注入契约、池子模型）见 `README.md`，不在此重复。本规格定义代码如何组织、数据如何建模、错误如何分类、如何测试。

## 2. 技术栈

| 项 | 选择 | 理由 |
|----|------|------|
| 语言/运行时 | Node/TS | 前后端项目最大公约数；未来 Java 项目本机不一定有 Python |
| 分发 | `npm i -g bookkeeper`，CLI 名 `bk` | |
| 测试运行器 | vitest | TS 原生、快、watch 体验好 |
| 真 infra 测试 | testcontainers-node | 自包含、CI 友好、零环境假设 |
| 文件锁 | `proper-lockfile`（或等价 flock） | 项目级锁 |
| Postgres / Redis / MinIO 客户端 | `pg` / `ioredis` / `minio` | 成熟生态 |
| YAML | `yaml` | 解析 `bk_config.yml` |

## 3. 模块分解

依赖单向、无环：`cli → core → {providers, frameworks, state, inject, launch, git}`，全体 `→ config`。providers/frameworks 互不依赖。

```
cli/         命令解析 + 用户 I/O（提示、确认、输出格式化）。薄层，只 dispatch
  init, worktree(create/delete), allocate, deallocate, start, list, destroy
core/        编排逻辑（不碰 I/O 细节、不碰具体 infra 命令）
  allocator    选号 → 探活 → 遍历 provider provision → 失败倒序回滚 → 写 state
  deallocator  解绑、status → free
  destroyer    护栏检查 → 遍历 provider destroy → 删 set 条目
providers/   ResourceProvider 实现
  port, postgres, redis, minio       plan / probe / provision / destroy / envVars
frameworks/  FrameworkAdapter 实现（服务侧抽象，无资源副作用）
  django, fastapi, vite              detect() / defaultStartCommand()
state/       state.json 读写、flock、原子写、config_fingerprint
config/      bk_config.yml 加载/校验、项目根向上查找
inject/      .env 标记块的读-合并-写、.gitignore 维护
launch/      bk start 的 tmux / iTerm / print 三策略
git/         git worktree add/remove 封装
```

**边界判断：**
- `providers/` 与 `frameworks/` 是两套对称但不同的抽象——providers 有 provision/destroy 副作用，frameworks 只需 detect + 算命令。不强行统一，避免接口充满"对 X 是 no-op"的空方法。
- `launch/` 独立成层——平台探测（macOS/Linux、是否在 tmux 内）+ 三策略自带复杂度，隔离后 `bk start` 编排保持干净、可 mock spawn 单测。
- `git/` 虽小仍独立——worktree 操作测试里不能真跑（需 mock），独立便于替身。

## 4. 核心抽象

### 4.1 ResourceProvider（infra 资源）

每类资源对同一组动作建模：算名 → 探活 → 供应 → 销毁 → 产出 env。

```ts
interface ResourceProvider {
  kind: 'port' | 'postgres' | 'redis' | 'minio'
  plan(n: number, ctx: Ctx): ResourceNames           // foo_2 / 10002 / foo-2 ...
  probe(n: number, ctx: Ctx): Promise<boolean>        // 真实探活，撞了返回 false（非异常）
  provision(n: number, ctx: Ctx): Promise<void>       // CREATE DATABASE / mb bucket（redis-prefix 为 no-op）
  destroy(n: number, ctx: Ctx): Promise<void>         // DROP / rm（也用作回滚 undo）
  envVars(n: number, ctx: Ctx): Record<string, string> // 产出 BK_* 变量
}
```

- 端口、服务命令归入类似的小接口族，但只 probe + envVars/command，不 provision。
- **回滚几乎免费**：allocator 记下已成功 provision 的 provider，致命错时倒序调其 `destroy()`。

各 provider 的 provision/destroy 语义：
- **postgres**：`CREATE DATABASE foo_N` / `DROP DATABASE foo_N`（单一本地 superuser 凭据）。
- **redis**：`isolation: key_prefix` → provision/destroy 均 no-op（前缀是逻辑约定；destroy 可选 `SCAN+DEL foo_N_*`）；`isolation: db_number` → 用 db 号 N，受 0-15 限制，N>15 抛致命错。
- **minio**：建/删 bucket `foo-N`（下划线转连字符）；destroy 先清空对象。
- **port**：provision/destroy 为 no-op；probe 尝试 bind 检测空闲。

### 4.2 FrameworkAdapter（服务）

```ts
interface FrameworkAdapter {
  type: 'django' | 'fastapi' | 'vite'
  detect(projectDir: string): boolean                 // 特征文件侦测
  defaultStartCommand(service: ServiceConfig, port: number): string
}
```

默认启动命令模板：
- django：`uv run python manage.py runserver 0.0.0.0:{port}`
- fastapi：`uv run uvicorn {app} --port {port}`（`app` 来自 config）
- vite：`npm run dev -- --port {port}`

config 中 `command` 字段可整体覆盖默认。

## 5. 数据模型：state.json

位置：`~/.bookkeeper/<project_name>/state.json`。存**固化解析值**（非派生），防 config 漂移。

```json
{
  "project_name": "foo",
  "config_fingerprint": "sha256:...",
  "sets": {
    "1": {
      "status": "allocated",
      "owner": { "worktree": "/abs/../foo.feature-login", "branch": "feature/login" },
      "resources": {
        "backend":  { "port": 10001 },
        "frontend": { "port": 10101 },
        "postgres": { "database": "foo_1" },
        "redis":    { "prefix": "foo_1_" },
        "minio":    { "bucket": "foo-1" }
      },
      "created_at": "<iso>"
    },
    "3": {
      "status": "free",
      "owner": null,
      "resources": {
        "backend":  { "port": 10003 },
        "frontend": { "port": 10103 },
        "postgres": { "database": "foo_3" },
        "redis":    { "prefix": "foo_3_" },
        "minio":    { "bucket": "foo-3" }
      },
      "created_at": "<iso>"
    }
  }
}
```

- `status: allocated` 绑定 worktree；`free` = 退回池子的空闲资源；`destroy` 删除整个 set 条目。
- `config_fingerprint` 用于检测 config 漂移——快照值与"当前 config 算出的值"不一致时 warn，但旧分配仍认快照。
- **并发**：单一项目级文件锁 `~/.bookkeeper/<project>/lock`，仅在"读-改-写 state.json"期间持有；写用临时文件 + 原子 rename，保证"state 说有 = 资源真有"。

## 6. 关键数据流：allocate

1. 加锁，读 state.json。
2. 选号：池中有 `free` set → 取最小号复用；否则取最小未占用号 N（销毁后留的空洞优先回填）。
3. 对该 N，遍历所有 provider 调 `probe(N)`；任一返回 false（撞了）→ 跳到下一个 N 重试（**跳号上限默认 20**，可 config 覆盖；超限抛致命错）。
4. 号确定后，遍历 provider 调 `provision(N)`，逐个记录成功者。
5. 若某 provision 抛 `BkError{recoverable:false}` → 倒序对已成功者调 `destroy(N)`，放弃 state 写入，报错 + remediation 退出。
6. 全部成功 → 收集各 provider 的 `envVars(N)` → `inject/` 写入 `.env` 标记块。
7. 更新 state.json（set N → allocated + owner + 固化 resources 快照），原子写，解锁。

`worktree create` = `git/` add → 上述 allocate（除非 `--no-allocate`）。
`worktree delete` = deallocate（status → free）→ `git/` remove。

## 7. 错误处理

```ts
class BkError extends Error {
  code: string          // 'PORT_IN_USE' | 'DB_EXISTS' | 'INFRA_UNREACHABLE' | 'PERMISSION_DENIED' | ...
  recoverable: boolean  // true = 跳号重试; false = 回滚中止
  remediation?: string  // 给用户的下一步提示
}
```

- **可恢复**（端口被占、库已存在）：由 `probe()` 返回 false 表达（高频正常路径，不用异常）→ 编排层跳号。
- **致命**（infra 连不上、权限不足、磁盘满）：`provision()` 抛 `BkError{recoverable:false}` → 回滚 + 报错。
- 用户面消息须清晰可行动：
  - info：`⚠ 端口 10002 被占用，已跳到 10003`
  - error：`✖ 无法连接 Postgres (localhost:5432)。你的本地开发数据库起了吗？ [INFRA_UNREACHABLE]`
- **退出码**：0 成功、1 致命错、2 用法错。
- **destroy 护栏**：占用中默认拒绝（`--force` 绕过）；默认交互确认（`--yes` 跳过）；必须带号；不支持销毁全部。

## 8. 测试策略

| 层 | 方式 | 速度 |
|----|------|------|
| core（跳号/回滚/护栏/锁） | fake provider/adapter 单测全部分支 | 快 |
| state / config / inject | 纯函数 + 临时文件单测 | 快 |
| frameworks（detect） | 对 fixture 假项目目录测侦测 | 快 |
| git | 临时目录跑真 git | 中 |
| launch | mock spawn，不真开 pane | 快 |
| providers（pg/redis/minio） | testcontainers 临时容器，打 `@integration` 标，无 Docker 则跳过 | 慢 |

- 覆盖重点：core 的编排分支（跳号、回滚、护栏拒绝、并发锁）是 bug 高发区，测厚。
- provider 集成测只需冒烟级：建库 → 存在 → 注入 env → 销毁 → 不存在。

## 9. 首批范围

- 服务框架：Django、FastAPI、Vite。
- infra：Postgres、Redis（key_prefix / db_number 双模式）、MinIO。
- 命令：`init` / `worktree create|delete` / `allocate` / `deallocate` / `start` / `list` / `destroy`。
- 后续（不在首批）：Java/Spring、其他 Node 框架、更细粒度锁、provider 插件化。
