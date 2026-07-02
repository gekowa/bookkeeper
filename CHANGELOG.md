# Changelog

本文件记录 BookKeeper（bk）的版本变更。

## [0.0.11] - 2026-07-02

### Added

- **SpringBoot 服务类型**：新增 `springboot` service 类型，支持 Java Spring Boot 项目。无默认启动命令，需配置 `startCommand` 数组指定启动方式。
- **`injectionMode` 机制**：两种配置注入模式——`dotEnv`（默认，django/fastapi/vite/arq/celery 写入 `.env`）与 `startupArgs`（springboot 默认，`bk start` 时注入进程）。
- **`startCommand` 数组支持**：service 的 `startCommand` 支持数组格式（多条命令 / 多个参数组合），支持丰富的 token 插值。
- **通用 token 解析器**：统一支持 `{self.port}`、`{<svc>.port}`、`{db.name}`、`{redis.db}`/`{redis.prefix}`、`{minio.bucket}`、`{infra.postgres.host|port|username|password}`、`{infra.redis.host|port}`、`{infra.minio.endpoint|access_key|secret_key}` 等 token，覆盖所有资源维度。
- **多模块 init 与 ORM 起草**：`bk init` 侦测多模块项目时，自动逐子目录生成对应的 service 配置；ORM 映射（如 Hibernate entity 发现、数据库驱动推断）作为后续扩展方向。

## [0.0.10] - 2026-06-28

### Added

- **Windows 支持**：`bk start` 在 Windows 上按是否安装 Windows Terminal 自动选策略——有 `wt.exe` 用 `wt`（单窗口平铺多 pane），否则用 `win`（每服务一个独立 PowerShell 窗口）。`stop`/`restart` 据此停服：优先按记录的 PID `taskkill /T /F` 杀整棵进程树，PID 缺失时按服务端口经 `Get-NetTCPConnection` 查属主兜底（无端口的 worker 依赖 wt pane 自报的 pidfile）。服务宿主优先 `pwsh`（PowerShell 7）、否则内置 `powershell` 5.1。

### Fixed

- `post_allocate` 钩子改用平台默认 shell 执行（Unix `/bin/sh`、Windows `cmd.exe`），此前硬编码 `sh -c` 在 Windows 上不可用，导致带 `post_allocate` 的 `bk allocate` 失败。
- `tmux` 会话名改用 `path.basename` 推导，修正 Windows 反斜杠 worktree 路径下会话名被整条路径污染的问题。

## [0.0.9] - 2026-06-24

### Added

- `bk stop [service]` 与 `bk restart [service]`：停止 / 重启「由 `bk start` 启动」的当前 worktree 服务。`bk start` 成功后记录运行句柄（iTerm 存 session id、tmux 存 session 与 pane id）；`stop` 关闭 iTerm pane（含无端口 worker）或 `kill-session`/`kill-pane`，`restart` = 停止 + 重读配置后重启。句柄失效时幂等跳过；`bk start` 已在运行时报错提示改用 `restart`。

## [0.0.8] - 2026-06-24

### Fixed

- `bk list` 现在按当前 `bk_config.yml` 过滤展示资源：只显示配置里仍声明的服务与基础设施。删除 `infra` 中的 postgres/redis/minio 或删除某个 `services` 条目后，即使该资源此前已分配，也不再显示；恢复配置即恢复显示。`bk allocate` 幂等命中时打印的资源同样按当前配置过滤。纯显示层过滤，不改写 state、不动 `.env`。

### Changed

- `bk init` 生成的 `bk_config.yml` 中 infra 配置改用 YAML 块格式（缩进写法）替代内联流式写法，生成的草稿更规范、可读性更好。

## [0.0.7] - 2026-06-22

### Changed

- `bk start` 的 iTerm 启动改为**均匀网格**布局：自动计算行列组合（每次切最大段），使各 pane 的宽度比、高度比尽量接近、不过分悬殊，多服务时不再出现个别窗口被挤得过小。原先的逐个垂直分割退化为这套网格几何的薄壳。

### Fixed

- iTerm 启动脚本对 `cwd` 与命令中的双引号、反斜杠做转义，避免路径/命令含特殊字符时破坏 AppleScript 字符串字面量、导致启动失败。

## [0.0.6] - 2026-06-22

### Fixed

- 同目录重复 `bk allocate` 改为**幂等**：在已分配的 worktree 里再次 `allocate` 不再报错或重复 provision，而是识别既有分配、复用同一套资源，并打印已有资源清单告知当前分配状态（不覆盖已写好的 `.env`）。

## [0.0.5] - 2026-06-22

### Added

- `bk list` 将**当前目录所在的 worktree 置顶并标识**：在某个已分配 worktree（含其子目录）内执行时，该 worktree 排在最前并加当前标记，其余按原序排列；嵌套命中时取路径最深的那个。

### Changed

- vite 默认启动命令加 `--strictPort`：端口被占用时**直接快速失败**，而非 Vite 默认的自动递增换端口。bk 已为每个 worktree 精确分配端口，冲突应当显式暴露而非被静默绕过。

## [0.0.4] - 2026-06-21

### Added

- **按 service 量身定制的 per-service `.env` 注入**：`.env` 不再统一写在 worktree 根，而是按每个 service 的 `dir` 分别写入 `{dir}/.env`；同目录的多个 service（如后端 + worker）合并到同一个标记块。
- 新增 service 级 `envs` 字段：声明该 service 要写进 `.env` 的变量（前端 vite 用它声明 `VITE_*`）。后端（django/fastapi/arq/celery）写 `BK_*` 隔离标识，vite **不写任何 `BK_`**，只写 `envs` 声明的变量；某 service 无变量可写时整个块不创建。
- `envs` 值支持占位符 `{<服务名>.port}`，引用某 service 的已分配端口（如 `http://localhost:{backend.port}`），分配时插值；引用不存在或无端口的服务名报 `CONFIG_INVALID`。
- `bk init` 自动探测前端：扫 vite 目录的 `.env`/`.env.example` 等，命中带端口的 `localhost` URL（如 `VITE_API_BASE=http://localhost:8000/...`）就把变量搬进 `envs` 并把端口替换成 `{backend.port}`；探不到则写注释 stub。

## [0.0.3] - 2026-06-21

### Changed

- Redis 默认隔离改为 **`db_number`**（之前是 `key_prefix`）：`.env` 默认写 `BK_REDIS_DB=<N>` 而非 `BK_REDIS_PREFIX=<project>_<N>_`。`infra.redis.isolation` 降为可选，缺省即 `db_number`；因 Redis 仅 db 0–15，并行上限为 16 套，需突破再显式配 `isolation: key_prefix`。
- `.env` 标记块**只写动态隔离标识**（数据库名、Redis db/前缀、MinIO 桶名），不再输出主机/端口/账号密码等静态连接信息——这些共享连接信息留给你自己在 `.env` 块外的 secrets 中管理，bk 不再托管。

## [0.0.2] - 2026-06-21

### Fixed

- `bk --version` 改为从 `package.json` 动态读取（原先硬编码为 `0.0.1`，发版后版本号显示不更新）。

## [0.0.1] - 2026-06-21

首个发布。`bk` 是管理同一台机器上多个并行 git worktree 所需本地资源与基础设施的 CLI。

### Added

- **配置 `bk_config.yml`**：声明 `project_name`、`services`（`type`/`port_base`/`command`/`app`/`dir`）、`infra`（postgres/redis/minio）；从任意子目录/worktree 自顶向上发现项目根；config fingerprint 追踪配置版本。
- **资源集与统一编号 N**：单一整数 `N` 驱动后端/前端端口、PostgreSQL 库名、Redis 前缀、MinIO 桶名的统一命名。
- **四类基础设施 provider**：port（`bind` 探活、撞了跳号）、postgres（建库/探活/删库，连接错分类）、redis（`key_prefix` / `db_number` 双模式，db_number 15 上限护栏）、minio（下划线转连字符的桶名、清空对象后删桶）。
- **框架侦测与默认启动命令**：django、fastapi、vite，外加无端口 worker arq、celery；Python 项目统一用 `uv`。
- **service `dir` 与无端口 worker**：每个 service 的启动命令在其 `dir` 下运行；arq/celery worker 不写 `port_base`，bk 不为其分配端口、`bk list` 也不展示它（复用同目录后端资源）。
- **`.env` 标记块注入**：只写 `# >>> bk managed >>>` 块内，绝不触碰块外已有 secrets；解绑时移除块；幂等维护 `.gitignore`。
- **池子模型**：`bk allocate` 复用空闲号/按需新建，`bk deallocate` 退回池子（不删数据），`bk destroy <n>` 真正销毁；最小空闲号优先复用；落号前对端口/库探活、撞了跳号并 warn。
- **CLI 子命令**：`bk init`、`bk allocate`、`bk deallocate`、`bk worktree create|delete`、`bk list`、`bk destroy`、`bk start`。
  - `bk init`：框架感知地侦测项目，生成 `bk_config.yml` 草稿并维护 `.gitignore`。
  - `bk worktree create <branch>`：git worktree add + 自动 allocate + 写 `.env`（`--no-allocate` 只建不分配）；目录命名 `<project>.<净化后的分支名>`。
  - `bk worktree delete [dir]`：git worktree remove + 自动 deallocate（资源退回池子）。
  - `bk allocate` 半途失败会尽力回滚已建资源，不留孤儿。
  - `bk destroy <n>`：`DROP DATABASE` + 删桶（不可逆）；占用护栏（`--force` 绕过）、交互确认（`--yes` 跳过）、必须带号。
  - `bk start [service]`：自动探测 tmux → iTerm → 降级打印，每个 service 一个 pane（`--tmux`/`--iterm`/`--print` 强制）。
- **状态存储** `~/.bookkeeper/<project_name>/state.json`：项目级文件锁 + 原子写，串行化并发分配、防止多个 worktree 抢同一套资源。
- **错误模型**：`CONFIG_INVALID`、`INFRA_UNREACHABLE`、`PROBE_EXHAUSTED`、`SET_IN_USE` 等结构化错误码，附带可读的修复建议。
