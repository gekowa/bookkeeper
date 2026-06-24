# Changelog

本文件记录 BookKeeper（bk）的版本变更。

## [0.0.9] - 2026-06-24

### Added

- `bk stop [service]` 与 `bk restart [service]`：停止 / 重启「由 `bk start` 启动」的当前 worktree 服务。`bk start` 成功后记录运行句柄（iTerm 存 session id、tmux 存 session 与 pane id）；`stop` 关闭 iTerm pane（含无端口 worker）或 `kill-session`/`kill-pane`，`restart` = 停止 + 重读配置后重启。句柄失效时幂等跳过；`bk start` 已在运行时报错提示改用 `restart`。

## [0.0.8] - 2026-06-24

### Fixed

- `bk list` 现在按当前 `bk_config.yml` 过滤展示资源：只显示配置里仍声明的服务与基础设施。删除 `infra` 中的 postgres/redis/minio 或删除某个 `services` 条目后，即使该资源此前已分配，也不再显示；恢复配置即恢复显示。`bk allocate` 幂等命中时打印的资源同样按当前配置过滤。纯显示层过滤，不改写 state、不动 `.env`。
