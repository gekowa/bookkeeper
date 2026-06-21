# BookKeeper：service 目录 + arq/celery worker 支持

日期：2026-06-21
状态：已批准设计，待写实现计划

## 背景

试用 `bk start` 时发现两个问题：

1. **启动目录错了**：`buildLaunchSpecs`（`src/launch/index.ts`）给所有 service 都写死 `cwd: worktreeDir`（worktree 根）。但 monorepo 里 backend 在 `backend/`、frontend 在 `frontend/`，`uv run python manage.py runserver` 必须在服务自己的子目录里跑，否则启动命令失败。`bk init` 其实已经是按子目录侦测 service 的（`init.ts`），但目录信息没存进 config，start 时丢失了。

2. **不支持 worker**：当前模型假设每个 service 都有端口——`port.ts` 给每个 service 分 `port_base + n`，`buildLaunchSpecs` 直接读 `set.resources[s.name].port`。arq / celery worker 不绑端口，会直接崩。但它们需要和后端一样的 `.env` 注入，且通常和后端在同一个目录，应该能像普通 service 一样在 iTerm2 / tmux 的 pane 里启动。

## 目标

- `bk start` 在每个 service 自己的目录里启动命令。
- 支持 arq / celery worker：无端口、共享后端 `.env`、可在 pane 中启动。

## 非目标

- 不改启动器三策略（iterm / tmux / print）的内部逻辑——它们已按 `LaunchSpec{name, command, cwd}` 工作，修好 cwd 与无端口 spec 后自动支持 worker。
- 不在 `bk list` 中展示 worker。worker 不占独立资源，自然从 `state.sets[n].resources` 中缺席即可，无需额外展示。
- 不做 worker 进程守护 / 健康检查（沿用"bk 不管进程生命周期"的既有边界）。

## 设计

### 问题1：service 目录

- `ServiceConfig`（`src/core/types.ts`）新增 `dir?: string`：相对 worktree 根的路径。
- `bk init`（`src/cli/commands/init.ts`，`buildConfigDraft`）侦测时写入：
  - 根级 service（`detectType(projectDir)` 命中）→ `dir: .`
  - 子目录 service → `dir: <子目录名>`
- `config/load.ts`：读取并透传 `dir` 字段。
- `buildLaunchSpecs`（`src/launch/index.ts`）：cwd 改为 `join(worktreeDir, s.dir ?? '.')`。缺省 `.` 保持向后兼容。

### 问题2：arq / celery worker（无端口）

**新增两个 framework adapter**，与 fastapi / django / vite 并列（`src/frameworks/`，注册到 `registry.ts`）：

- `arq`：默认命令 `uv run arq <app>.WorkerSettings`（复用现有 `app` 字段；无 `app` 时报 `CONFIG_INVALID`，提示设置 `app` 或 `command`，与 fastapi 一致）。
- `celery`：默认命令 `uv run celery -A <app> worker`（同上）。
- `ServiceType` 联合类型增加 `'arq' | 'celery'`。
- 两个 adapter 的 `detect()` 一律返回 `false`：worker **不参与 `detectType` 的目录主类型侦测**（否则一个 backend 目录会同时匹配 fastapi 和 arq，污染 init 的"每目录一 service"逻辑）。init 的 worker stub 侦测走独立的 pyproject 依赖检查（见下），与 `detectType` 解耦。

**"无端口" = config 不写 `port_base`**：

- `config/load.ts`：`port_base` 从"必填"改为"有则校验为数字、无则视为无端口 service"。
- `providers/port.ts`：`plan` / `probe` 只针对有 `port_base` 的 service 分配 / 探活端口；无 `port_base` 的跳过。
- `buildLaunchSpecs`：无端口 service 的 port 传 `undefined`；adapter 默认命令不引用 `{port}`；若用户自定义 `command` 含 `{port}` 但 service 无端口，视为配置错误（`CONFIG_INVALID`）。
- `adapterFor(type).defaultStartCommand` 签名的 `port` 参数变为可选（`number | undefined`）；有端口 adapter（fastapi/django/vite）在 port 缺失时报错，worker adapter 忽略 port。

**`bk init` 侦测 worker**：

- 当某 backend 目录的 `pyproject.toml` 含 arq / celery 依赖时，在该目录对应的 service 之后，追加一段**注释掉的 worker stub**，例如：

  ```yaml
    # backend_worker:
    #   type: arq
    #   dir: backend
    #   app: app.worker   # TODO 填 WorkerSettings 所在模块
  ```

  仅在侦测到依赖时输出，不乱猜 `app` 路径；用户取消注释并填 `app` 即可启用。

### 启动器

无需改动。修好问题1的 cwd、问题2的无端口 spec 后，print / tmux / iterm 三策略自动都能在 pane 里跑 worker。

## 测试

- `buildLaunchSpecs`：cwd 正确解析 `dir`（含缺省 `.`）；无端口 service 走 adapter 默认命令、不含 port。
- `providers/port.ts`：跳过无 `port_base` 的 worker，只给有端口的 service 分配 / 探活。
- `config/load.ts`：无 `port_base` 的 service 正常加载为 worker；有 `port_base` 但非数字时报错；透传 `dir`。
- `frameworks/arq.ts`、`celery.ts`：默认命令正确；缺 `app` 时报 `CONFIG_INVALID`。
- `bk init`：侦测到 arq/celery 依赖时输出注释 worker stub；服务写出 `dir` 字段。

## 影响文件

- `src/core/types.ts`（`dir`、`ServiceType` 扩展）
- `src/config/load.ts`（`dir` 透传、`port_base` 可选）
- `src/launch/index.ts`（cwd、无端口分支）
- `src/providers/port.ts`（跳过 worker）
- `src/frameworks/types.ts`（`defaultStartCommand` port 可选）
- `src/frameworks/arq.ts`、`src/frameworks/celery.ts`（新增）
- `src/frameworks/registry.ts`（注册）
- `src/cli/commands/init.ts`（`dir` 写出、worker stub 侦测）
- 对应测试文件
