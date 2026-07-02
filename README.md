# BookKeeper

BookKeeper（`bk`）是一个 **strongly opinionated** 的 CLI 工具，用于管理在同一台机器上并行运行多个 git worktree 时所需的本地资源与基础设施。

## 心智模型

回想没有 AI 的时候：你雇了一个新开发者，给他一台电脑，他装好开发环境（开发工具包、数据库、Redis、MinIO 等）。这些基础设施一旦稳定，就会长期存在——即使他被调到另一个项目，只要数据库选型相同，他不必重装数据库软件，只需**新建一个数据库、建好表**即可开工。

BookKeeper 扮演的正是"记账员"：它不安装、也不照看这些基础设施软件本身，而是帮你**记住并分配**每个 worktree 该用哪套逻辑资源（端口、数据库、桶、key 前缀），并无感地注入到项目配置里。

## 要解决的问题

开发 B/S 架构项目（如 FastAPI/Django + Vue 3），手动 E2E 测试前需要先搭好基础设施（数据库、内存存储、块存储）并启动至少 2-3 个服务，微服务项目更多。过去本机开发时，这些为测试而起的服务被当作临时品，只起一套、也不处理资源冲突。

用 AI 编程后情况变复杂了：你总需要 AI 在同一台机器上**同时处理多个任务**。代码隔离已有完美方案——git worktree；但**本地资源与基础设施的分配**，还需要 BookKeeper 来补齐。

## 设计理念

BookKeeper 是**强约定**的工具，命令设计偏好约定与隐喻、刻意砍掉参数：能用一条稳定约定推导出来的东西，就绝不做成 flag 让你去填。

**职责边界（重要）：**

- **bk 管**：逻辑资源的**存在与归属**——创建/分配/回收/销毁数据库、桶、key 前缀、端口，并记录哪个 worktree 占用了哪一套。
- **bk 不管**：
  - 基础设施**软件本身**的生命周期（Postgres/Redis/MinIO 进程由你预装、长期稳定运行，bk 只读取它们的连接信息）。
  - 资源的**内容**——建表、灌种子数据、让库"可用"，全是项目自己的事（项目本来就有 migration 和 seed 脚本）。
  - 应用**进程的生命周期**——`bk start` 只负责把服务跑起来，不做守护、不做崩溃重启、不做健康检查。

## 核心概念

### 资源集与统一编号 N

一个 worktree 对应一套**资源集**，由单一整数 `N`（从 1 起）统一驱动所有命名，让一切天然对齐、好记好排查：

| 资源 | 命名规则 | 示例（`project_name=foo`, `N=2`） |
|------|---------|----------------------------------|
| 后端端口 | `port_base + N` | `10002` |
| 前端端口 | `port_base + N` | `10102` |
| PostgreSQL 数据库 | `<project>_<N>` | `foo_2` |
| Redis key 前缀 | `<project>_<N>_` | `foo_2_` |
| MinIO bucket | `<project>-<N>` | `foo-2`（下划线在 bucket 名中非法，转连字符） |

### 池子模型（资源是耐久资产）

资源像"新员工电脑里那套装好的数据库"——用完归还、留着复用，不轻易销毁：

- `bk allocate`：当前 worktree 领一套资源。**池中有空闲就给一套**，没有就当场 on-demand 建一套。
- `bk deallocate`：解绑，资源**退回池子**（数据/表全保留，不删）。
- `bk destroy <n>`：**真正销毁**第 n 套资源（`DROP DATABASE`、删桶）。
- bk **绝不自动 destroy**——空闲资源无限期保留等待复用。
- 销毁后**最小空闲号优先复用**。

### 防撞（尽力代做，非职责保证）

bk 不承诺"绝对无冲突"，但会尽力：`allocate` 落号前对真实世界探活（端口能否 bind、库是否已存在），**撞了就跳号并 warn**。

## 安装

```bash
npm i -g bookkeeper
```

```
$ bk
# 输出帮助信息
```

## 配置：`bk_config.yml`

放在 main 仓库根、提交进 git。`bk` 在任意子目录/worktree 内向上遍历查找它来定位项目根。

```yaml
---
project_name: foo

services:
  backend:
    type: django          # django | fastapi | arq | celery
    port_base: 10000
    dir: backend          # 启动命令运行的目录（相对 worktree 根，缺省为根 `.`）
    # command:            # 可选，覆盖按 type 推导的默认启动命令
    # app: app.main:app   # fastapi 专用，喂给默认 uvicorn 模板
    post_allocate: uv run python manage.py migrate && uv run python manage.py seed  # 分配落地后自动跑（可选）
  frontend:
    type: vite
    port_base: 10100
    dir: frontend
    post_allocate: npm install  # 分配落地后自动跑（可选）
    envs:                                   # 前端要写进 .env 的变量（值支持占位符）
      VITE_API_BASE: http://localhost:{backend.port}
  worker:                 # arq/celery worker：无端口，不写 port_base
    type: arq             # arq → uv run arq {app}.WorkerSettings
    dir: backend          # 通常与后端同目录，复用后端代码与 .env
    app: app.worker

infra:
  postgres:
    host: localhost
    port: 5432
    username: postgres    # 本地 superuser，建库与 app 共用
    password: postgres
  redis:
    host: localhost
    port: 6379
    isolation: db_number  # 默认 db_number（redis 仅 0-15，并行上限 16 套）；要突破上限再显式改 key_prefix
  minio:
    endpoint: localhost:9000
    access_key: minioadmin
    secret_key: minioadmin
```

> 凭据明文写在提交进 git 的 config 里——仅适用于"本地 Docker、可丢弃的 dev 实例"。切勿将此 config 指向任何非本地基础设施。

用 `bk init` 可框架感知地自动侦测当前项目（先认 service 类型，再据类型去翻该框架的惯例配置位如 `settings.py`/`config.py`/`.env` 提取 infra 连接信息；`docker-compose.yml` 作为靠后的补充来源），生成 `bk_config.yml` 草稿，**请审核后再使用**。

### 默认启动命令（按 type 推导，`{port}` 由 bk 填）

| type | 默认命令 | 端口 |
|------|---------|------|
| `django` | `uv run python manage.py runserver 0.0.0.0:{port}` | 需要 |
| `fastapi` | `uv run uvicorn {app} --port {port}` | 需要 |
| `vite` | `npm run dev -- --port {port}` | 需要 |
| `springboot` | 无（必须配 `startCommand`） | 需要 |
| `arq` | `uv run arq {app}.WorkerSettings` | 无 |
| `celery` | `uv run celery -A {app} worker` | 无 |

Python 项目一律用 `uv`。

### service 目录与无端口 worker

- **`dir`**：每个 service 的启动命令在该目录下运行（相对 worktree 根，缺省为根 `.`）。monorepo 里 `backend/`、`frontend/` 各填自己的目录，`bk start` 才能在对的地方跑起来。`bk init` 会按侦测到的子目录自动写好 `dir`。
- **无端口 worker（arq/celery）**：后台任务进程不监听端口，因此**不写 `port_base`**——bk 不为它分配端口、`bk list` 也不展示它（它不占独立资源，复用同目录后端的数据库/Redis/桶）。`bk init` 侦测到 backend 的 `pyproject.toml` 含 arq/celery 依赖时，会生成一段**注释掉的 worker stub**，取消注释并把 `app` 填成 WorkerSettings/celery app 所在模块即可启用。

## 配置注入

`bk allocate` 时（即 `bk worktree create` 一步到位时），bk 往**每个 service 目录**（`dir`，缺省为 worktree 根）的 `.env` 写入一个**标记块**，只动块内、绝不碰你已有的 secrets。**写什么按 service 量身定制**：

后端（django/fastapi，及同目录的 arq/celery worker）目录里：

```
# >>> bk managed >>>
BK_DB_NAME=foo_2
BK_REDIS_DB=2
BK_MINIO_BUCKET=foo-2
# <<< bk managed <<<
```

前端（vite）目录里只写你在 `envs` 里声明的变量（占位符已插值）：

```
# >>> bk managed >>>
VITE_API_BASE=http://localhost:10001
# <<< bk managed <<<
```

- **后端只写动态隔离标识**——数据库名、Redis db 号、MinIO 桶名。主机/端口/账号密码这些共享静态连接信息不归 bk 管，留在你自己 `.env` 的 secrets 里（块外，bk 绝不触碰）。
- **前端写 `envs`**：在 vite service 上声明 `envs` 映射，值里可用占位符 `{<服务名>.port}` 引用某 service 的已分配端口（如 `{backend.port}`）。bk 在 allocate 时插值后写入。**vite 不写任何 `BK_` 变量**；**没写 `envs` 就什么都不写**。
- **占位符**：首批支持 `{<服务名>.port}`；引用了不存在或无 `port_base` 的服务名会报 `CONFIG_INVALID`。
- **`bk init` 会探测前端**：扫前端目录的 `.env`/`.env.example`/`.env.local`/`.env.development`，命中 `VITE_*=http://...localhost...` 就把变量名与格式搬进 `envs`（端口替换成 `{backend.port}`）；探不到则留一段注释掉的 `envs` stub 供你启用。
- **监听端口仍走启动命令参数**（各框架原生读各自目录下的 `.env`）。
- **写在每个 service 的目录里**：同目录多个 service（如后端 + worker）共用一份，env 需求合并。
- `.env` 含本机私有分配值，`bk init` 会把它加进 `.gitignore`。

> 时序保证：`bk worktree create` 返回那一刻，`.env` 已写好且指向正确的库。因此你/AI 任何时候跑 `uv run python manage.py migrate` / seed，都会落进正确的库。资源初始化流程由你的项目决定（通常 migration 自动、seed 手动），bk 提供钩子但不代劳。想自动化可配 post_allocate 钩子，见下节。

### post_allocate 钩子

每个 service 可选配置 `post_allocate` 字段，指定一条 shell 命令。allocate 完成后（`.env` 已写入），bk 会在该 service 的目录（`dir`）执行该命令，**注入该目录的 `BK_*` 变量和 `BK_N`**，用于初始化资源（如运行数据库 migration、创建桶、初始化缓存等）。

```yaml
services:
  backend:
    type: django
    port_base: 10000
    dir: backend
    post_allocate: uv run python manage.py migrate
```

**执行特征**：
- **时序**：仅在 allocate 实际写入 `.env` 时执行（复用已有资源、同目录重复 allocate 不触发）。
- **环境**：钩子在 service 的 `dir` 下运行；注入该目录写进 `.env` 的同一批 `BK_*` 变量，外加 `BK_N`（资源集编号），可在命令中引用。
- **失败策略**：命令失败采用 fail-fast（停在出错的 service，不跑后续），**worktree、已分配资源、.env 全部保留、不回滚**；修好后用 `bk setup` 重跑钩子，无需重建 worktree。
- **重新执行**：新 worktree 创建后无需手动复跑；或用 `bk setup` 为当前 worktree 重新执行所有钩子。

### injectionMode 与 SpringBoot

- `injectionMode`：`dotEnv`（默认，django/fastapi/vite/arq/celery）把变量写进 service 目录 `.env`；`startupArgs`（默认，springboot）改为在 `bk start` 时注入进程。
- SpringBoot 默认不读 `.env`，故用 `startupArgs`：
  - **命令行参数 / `-D` 系统属性**：写进 `startCommand` 数组元素，用 token 插值，位置由你掌控（`java -jar` 后、或 `mvn -Dspring-boot.run.arguments=` 里）。
  - **进程环境变量**：写进 `envs`（key 为大写环境变量名），bk 启动前注入进程环境。
- token：`{self.port}`、`{<svc>.port}`、`{db.name}`、`{redis.db}`/`{redis.prefix}`、`{minio.bucket}`、`{infra.postgres.host|port|username|password}`、`{infra.redis.host|port}`、`{infra.minio.endpoint|access_key|secret_key}`。
- springboot 无默认启动命令，必须配 `startCommand`。多模块：一模块一 service，`bk init` 自动逐子目录侦测。

## 使用

### 创建 worktree

在 **main 分支目录**下，只给分支名：

```bash
bk worktree create <branch>
```

约定：worktree 建在当前目录的**父目录**下，目录名为 `<project_name>.<branch>`（分支名里的 `/` 会净化为 `-`，git 分支名本身保持原样）。该命令会 git worktree add → 自动 allocate → 写 `.env` → **执行 post_allocate 钩子**。

```
# 在 foo 的 main 目录下
$ bk worktree create feature/login
# → 创建 ../foo.feature-login，并分配资源、写好 .env、执行配置的 post_allocate
```

**可选标志**：
- `--no-allocate`：只建 worktree、暂不占资源。
- `--no-hook`：allocate 后跳过 post_allocate 钩子（需要资源但暂不初始化时用）。

### 启动服务

```bash
bk start [service]
```

把每个 service 的启动命令**在其 `dir` 下**跑起来：自动探测 **tmux → iTerm → 降级打印**，每个 service 一个 pane（`--tmux` / `--iterm` / `--print` 可强制）。无端口 worker（arq/celery）和普通服务一样在 pane 中启动。**bk 仍不守护进程**（不做崩溃自动重启、不做健康检查），但它记住自己启动了什么，因此可用 `bk stop` / `bk restart` 停止或重启（见下）。

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

> **tmux 注意**：单个服务的 `restart` 若其余服务仍在同一 tmux session 中运行，可能因重建同名 session 冲突而报错——改用整组 `bk restart`（不带 service），或 `bk stop` 后再 `bk start`。

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
- `wt` 策略下，服务 `command` 覆盖中含有 `;`（分号）会被 `wt.exe` 误作子命令分隔符，导致拆分成多个 pane；避免在 Windows 的 `command` 覆盖里用 `;`（内置默认命令不含 `;`，不受影响）。
- `wt` 下被 `stop` 的 pane 会显示「进程已退出」但 pane 不会自动关闭，需手动关（与 tmux 死 pane 同理）。

### 观测

```bash
bk list
```

```
Project Name: foo

Worktree: ../foo.feature-login  (Set 1)
  - backend  10001
  - frontend 10101
  - PostgreSQL: foo_1
  - MinIO bucket: foo-1
  - Redis prefix: foo_1_

Worktree: ../foo.fix-bar
  No resource allocated.

Unallocated (in pool):
  Set 3
  - backend  10003
  - frontend 10103
  - PostgreSQL: foo_3
  - MinIO bucket: foo-3
  - Redis prefix: foo_3_

Next free number: 4
```

`bk list` 的展示**随当前 `bk_config.yml` 过滤**：只显示配置里仍声明的 service 与 infra。若你删掉了 `infra` 里的 postgres/redis/minio 或某个 `services` 条目，即使该资源此前已分配，也不再列出；恢复配置即恢复显示。这是纯显示层过滤，不改写 state、不动 `.env`。

### 手动分配 / 回收（边缘场景）

日常用 `worktree create`/`delete` 即可，下面两条用于换资源、迟分配等微调：

```bash
bk allocate     # 当前 worktree 领一套资源（无参数）
bk deallocate   # 当前 worktree 解绑，资源退回池子（不销毁）
```

`bk allocate` 半途失败会**尽力回滚**到分配前的干净状态，不留孤儿资源。

`bk allocate` 时可加 `--no-hook` 标志，跳过 post_allocate 钩子的执行。

### 重跑 setup 钩子

```bash
bk setup
```

为当前 worktree 重新执行所有配置的 post_allocate 钩子。用于以下场景：

- allocate 时因钩子失败而中断，修复问题后需要重新初始化资源。
- 手动修改配置或资源状态后，需要重新运行初始化逻辑。

当前 worktree 未分配资源时 `bk setup` 报错（提示先 `bk allocate`）。

### 删除 worktree

```bash
bk worktree delete [dir]   # 无参 = 删当前 worktree
```

会 git worktree remove + **自动 deallocate**（资源退回池子，**不销毁**）。

### 销毁资源

```bash
bk destroy <n>
```

真正 `DROP DATABASE` + 删桶，**不可逆**。护栏：

- 资源正被某 worktree 占用 → 默认拒绝（`--force` 绕过）。
- 默认交互确认（`--yes` 跳过，供 AI/脚本）。
- 必须带号，不支持"销毁全部"。

## 状态存储

中心状态文件（机器级、项目维度一份）：

```
~/.bookkeeper/<project_name>/state.json
```

记录每套资源的归属，原子写 + 文件锁防止并发 worktree 抢同一套资源。它是分配关系的唯一真相源——按 `project_name` 维度，与代码仓库解耦（资源分配是本机事实，不进 git）。

## 实现

Node/TS 实现，`npm i -g bookkeeper`。Node 是前后端项目的最大公约数（未来支持 Java 项目时，本机不一定有 Python，但一定有 Node）。

首批支持：**Django、FastAPI、Vite**，外加无端口 worker **arq、celery**；Java、其他 Node 框架后续再说。
