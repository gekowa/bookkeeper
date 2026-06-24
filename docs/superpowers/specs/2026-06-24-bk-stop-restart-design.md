# bk stop / restart（停止与重启当前 worktree 的服务）

- 日期：2026-06-24
- 状态：设计已批准，待写实现计划

## 背景与问题

`bk start [service]` 把每个 service 的启动命令在其 `dir` 下跑起来（tmux → iTerm → 降级打印），但**完全不追踪进程**。README 明确写着：「bk 不监管进程——停止/重启/看输出都交给终端」。

实际用 AI 并行开发时，频繁要停掉一组服务、或改了配置后重起一遍。手动去关 iTerm 窗口、一个个 Ctrl-C 很烦。本设计给 `bk start` 补上 `stop` / `restart`，作为它的对偶命令。

这是对「bk 不管进程生命周期」这条理念的一次**有意扩张**：bk 仍然不做守护、不做崩溃重启、不做健康检查，但它**记住自己启动了什么**，于是能忠实地把自己起的那组服务停掉、或重起。它只对「由 bk 启动」的服务负责。

## 核心决策（来自 brainstorming）

1. **命令镜像 start**：`bk stop [service]` / `bk restart [service]` 与 `bk start [service]` 形态完全一致。不带参数 = 当前 worktree 整组；带参数 = 仅该 service。解析 worktree → N 的方式复用 `findSetByWorktree(cwd)`。
2. **运行句柄记录在 SetRecord 上**：worktree ↔ N ↔ 运行记录天然 1:1，新增可选 `run?` 字段，复用现有锁 + 原子写，不另开文件。
3. **iTerm 走 session unique id（方案 A）**：`start` 时捕获每个 pane 的 `unique id`，`stop` 时 `close` 该 session —— 关 pane 同时杀掉进程，**含无端口 worker**，且不改动用户的启动命令、无窗口残留。优于「记 PID 后 kill」（会残留空 pane、且捕获 PID 要改启动命令）。
4. **tmux 走 session + pane id**：停全部 = `kill-session`，停单个 = `kill-pane`。
5. **`print` 不记录**：用 `--print` 自己手动跑的服务 bk 没有句柄，不归 bk 管。
6. **restart = stop + start，重读配置**：重启自动吃到 `bk_config.yml` 的改动（命令/端口/新增 service）。没在跑时静默当 start。
7. **start 护栏**：`start` 时若已有运行记录 → 报错提示改用 `restart`，避免重复启动占端口、开重复窗口。start 的「启动」语义保持纯粹。
8. **stop 幂等容错**：句柄失效（用户手动关了窗口/会话）→ 跳过、不报错，清掉记录。

## 设计

### 1. 命令表面

```
bk start   [service]   # 现有
bk stop    [service]   # 新增
bk restart [service]   # 新增
```

`stop` / `restart` 不带 launcher flag（`--tmux` / `--iterm` / `--print`）——它们作用于「已记录的运行方式」，无需用户再指定。`restart` 内部转身调 start 时，按 `run.strategy` 决定重启用哪种 launcher（保持与上次一致），无记录时回落到 `selectStrategy(env)` 的自动探测。

### 2. 运行记录数据模型

在 `SetRecord`（`src/core/types.ts`）新增可选字段：

```ts
interface RunService {
  name: string
  itermSessionId?: string   // strategy === 'iterm'
  tmuxPaneId?: string       // strategy === 'tmux'，支持单服务停
}
interface RunRecord {
  strategy: 'tmux' | 'iterm'   // 'print' 不记录
  startedAt: string
  tmuxSession?: string         // strategy === 'tmux'
  services: RunService[]
}
interface SetRecord {
  // …现有字段…
  run?: RunRecord
}
```

写入/清理时机：
- `bk start` 成功派发后写入 `run`（在 `withState` 事务内）。
- `bk stop`（全部）成功后删除 `run`。
- `bk stop [service]` 后从 `run.services` 移除该条；若 `services` 空了则删除整个 `run`。
- `deallocate` 不主动 stop，也不强行清 `run`（保持「bk 不激进管进程」）；遗留的 `run` 会因句柄失效而在下次 stop 时被幂等清理。

### 3. iTerm 机制（方案 A）

**捕获 unique id（改 `src/launch/iterm.ts`）**

`buildItermScript` 在写完所有 `write text` 之后，按 service 顺序追加返回每个 session 的 unique id：

```applescript
…既有分屏与 write text…
return {unique id of s<sid0>, unique id of s<sid1>, …}
end tell
```

`sid` 取自 `plan.order[k]`（第 k 个 service 落在哪个 session）。`runIterm` 用 execa 捕获 osascript 的 stdout（AppleScript 列表以 `", "` 分隔），按顺序映射 `services[k].name → itermSessionId`，由调用方写入 `run`。

`runIterm` 需从「只下发、不取返回」改为「返回 `string[]`（按 spec 顺序的 session id）」，以便上层组装 `RunRecord`。

**停止**

对每个待停 service：
```applescript
tell application "iTerm2"
  tell session id "<itermSessionId>" to close
end tell
```
`close` 会关闭 pane 并终止其中运行的进程（含无端口 arq/celery worker）。

**容错**：`session id` 已不存在时 AppleScript 报错 —— 逐个 session 独立执行并吞掉「找不到」类错误，视为「已停」。

**已知注意（写进 README）**：若 iTerm 偏好里开了「关闭仍在运行任务的会话需确认」，`close` 可能弹确认框。需在文档提示用户在 iTerm → Settings → Profiles → Session 把「Prompt before closing / Confirm 'Send text…'」相关项关掉，或在 General 里关掉运行中会话的关闭确认。

### 4. tmux 机制

**捕获 pane id（改 `src/launch/tmux.ts`）**

`new-session` / `split-window` 加 `-P -F '#{pane_id}'`，stdout 即该 pane 的 id：

```
tmux new-session -d -s <session> -c <cwd> -P -F '#{pane_id}' <command>
tmux split-window -t <session> -c <cwd> -P -F '#{pane_id}' <command>
```

`runTmux` 收集每个 pane id，返回 `{ session, paneIds: string[] }`（按 spec 顺序），由上层写入 `run`。`session` 名沿用现有规则 `bk-<first.cwd basename>`。

**停止**
- 停全部：`tmux kill-session -t <tmuxSession>`。
- 停单个：`tmux kill-pane -t <tmuxPaneId>`。

**容错**：session/pane 不存在时 tmux 退出非零 —— 吞掉这类错误，视为「已停」。

### 5. restart

`restart [service]` =
1. 读 `run`（无则跳过 stop）。
2. 对目标范围执行 stop（同 §3/§4）。
3. 重新 `loadCtx()` + `buildLaunchSpecs(...)`（重读配置），按 `run.strategy`（无记录时 `selectStrategy`）执行 start，写新 `run`。

整个过程在一次命令内完成；stop 与 start 复用同一套底层函数，不复制逻辑。

### 6. 错误处理与边界

| 场景 | 行为 |
|------|------|
| 当前 worktree 未分配资源 | 复用 `start` 的 `NOT_IN_WORKTREE`（`先运行 bk allocate`） |
| `stop` 时无 `run` | 提示「当前没有由 bk 启动的服务在运行」，退出 0 |
| `stop [x]` 但 x 不在 `run.services` | 提示该服务未在运行 |
| `restart` 无 `run` | 静默当 start |
| 句柄全部失效 | 当作已停止，清记录，正常返回 |
| `start` 已有 `run` | 报错：`服务已在运行，改用 bk restart`（新增错误码或复用既有码） |
| `--print` 启动 | 不写 `run`；`stop` 落到「无运行记录」分支 |

### 7. 文件改动清单（预估）

- `src/core/types.ts`：`SetRecord.run?` + `RunRecord` / `RunService` 类型。
- `src/launch/iterm.ts`：`buildItermScript` 加 `return`；`runIterm` 返回 session id 列表。
- `src/launch/tmux.ts`：`runTmux` 加 `-P -F` 捕获并返回 pane id 列表与 session 名。
- `src/launch/index.ts`：`runLaunch` 透传/返回运行句柄，供上层组装 `RunRecord`。
- `src/launch/stop.ts`（新）：按 strategy 关闭 iTerm session / tmux pane|session 的纯粹停止逻辑。
- `src/cli/commands/stop.ts`（新）、`src/cli/commands/restart.ts`（新）。
- `src/cli/commands/start.ts`：加「已在运行」护栏 + 派发成功后写 `run`。
- `src/cli/index.ts`：注册 `stop` / `restart`。
- `README.md`：补 stop/restart 文档 + iTerm 关闭确认注意点。

## 测试策略

沿用现有 vitest 风格，把「真正杀进程/起窗口」的副作用隔离在 launcher 边界，mock `execa`：

- **纯函数单测**：
  - `buildItermScript` 末尾 `return {unique id …}` 的脚本正确（顺序对齐 `plan.order`）。
  - tmux 命令参数含 `-P -F '#{pane_id}'`。
  - stop 的「待停 service 筛选」「`run` 读写/清理（停单个 vs 停全部 vs 清空后删 run）」逻辑。
  - restart 的 stop→start 串联（用 mock 验证调用顺序与重读配置）。
- **mock 副作用**：mock `execa` / `osascript`，断言下发的命令行与 AppleScript 文本正确，不真正起窗口或杀进程。
- **容错**：mock `execa` 抛「session/pane 不存在」错误，断言 stop 吞错、清记录、退出 0。
- 复用 `findSetByWorktree`、state store 的现有测试设施与 `tests/fixtures`。

## 非目标（YAGNI）

- 不做守护进程 / 崩溃自动重启 / 健康检查（理念不变）。
- 不管 `--print` 或手动启动的服务。
- 不做跨 worktree 的批量 stop（`stop` 始终作用于当前 worktree）。
- 不抓取 / 转存服务日志（看输出仍交给终端）。
