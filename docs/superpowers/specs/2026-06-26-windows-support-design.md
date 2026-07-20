# Windows 支持设计（Windows Support Design）

> 状态：已批准（brainstorming → writing-plans）
> 日期：2026-06-26

## 背景

BookKeeper（`bk`）的大部分代码是跨平台的纯 Node：资源分配（Postgres/Redis/MinIO 客户端、端口探活）、配置发现（`config/discover.ts` 用 `node:path` 向上遍历）、状态存储与锁（`proper-lockfile`）。唯一与操作系统强绑定的是**启动层（launch layer）**——`bk start` / `bk stop` / `bk restart` 如何把每个服务跑进一个终端 pane。

当前启动层有三种策略：

- **`tmux`** —— 切 pane（Linux/macOS）。
- **`iterm`** —— macOS 专用，经 `osascript` 跑 AppleScript。
- **`print`** —— 兜底，只把命令打印出来。

`selectStrategy`（`launch/index.ts`）在 Windows 上会落到 `print`，于是 `bk start` 只打印命令、从不真正启动任何东西。

此外还有第二个硬阻塞：`post_allocate` 钩子经 `execa('sh', ['-c', cmd])`（`hooks/postAllocate.ts:25`）执行，而 stock Windows 上没有 `sh`，所以带 `post_allocate` 的 `bk allocate` 也会失败。

本设计的目标：**让 `bk` 在 Windows 上真正可用**——`allocate` + `start` + `stop` + `restart` 全部跑通。

## 决策摘要（来自 brainstorming）

1. **启动策略**：Windows Terminal（`wt.exe`）存在则用 `wt`（平铺 pane，最贴近 tmux/iTerm 体验）；否则回退到独立 PowerShell 窗口（每个服务一个窗口）。
2. **wt 下的 stop 句柄**：PID 自报（pidfile）为主，端口查找（`Get-NetTCPConnection`）为兜底。
3. **范围**：完整——启动层 + `post_allocate` 的 shell 执行修复 + 路径/句柄 bug 清扫 + 测试 + 文档。

## 架构

改动集中在 `src/launch/`，外加一个钩子修复（`hooks/postAllocate.ts`）和类型扩展（`core/types.ts`）。资源层不动。

### 1. 策略选择（`launch/index.ts`）

新增两种策略 `'wt'` 与 `'win'`，加入现有三种。`selectStrategy` 增加 Windows 分支。由于 wt 是否存在是**运行时探测**（不是环境变量），把可用性通过 options 对象传入，使函数保持纯、可测：

```
selectStrategy(env, { force?, hasWt? })
  force?                                   -> force
  env.TMUX                                 -> 'tmux'
  darwin + TERM_PROGRAM=iTerm.app          -> 'iterm'
  win32 + hasWt                            -> 'wt'
  win32 + !hasWt                           -> 'win'   （独立窗口）
  else                                     -> 'print'
```

> 平台来源沿用既有约定：`env.__platform ?? process.platform`（测试用 `__platform` 注入）。

真实调用方（`doStart`）通过在 `PATH` 上探测 `wt.exe` 计算 `hasWt`；测试直接传入 `hasWt`（与现有 `__platform` 注入风格一致）。

**`hasWt` 探测**：用一个小 helper（如 `commandExists('wt')`），在 win32 上用 `where.exe wt`（或检查 `where wt` 退出码）判断；非 win32 直接返回 false。该探测只在 `doStart` 里调用一次。

### 2. 两个新启动器

#### `launch/wt.ts` —— `runWt(specs): Promise<{ pids: (number | undefined)[] }>`

- 构建**单条** `wt` 调用，平铺多 pane，**复用 `itermGrid.ts` 的 `planGrid`** 决定分屏几何。
- 每个 pane 在 PowerShell 里跑一个会**自报 PID 到 pidfile** 的包装命令：

  ```
  pwsh -NoExit -Command "$PID | Out-File -Encoding ascii '<pidfile>'; <command>"
  ```

  （`wt` 会吞掉被启动进程的 PID，pidfile 正是为此而存在。）
- 启动后回读各 pidfile，得到每个服务的 PID。
- pidfile 路径放在 OS 临时目录下，按 `project / N / service` 命名，避免冲突。
- PowerShell 宿主：`pwsh`（7+，支持 `&&`）存在则用，否则 `powershell`（5.1）。

#### `launch/win.ts` —— `runWin(specs): Promise<{ pids: number[] }>`

- 用 Node 的 `spawn(shell, ['-NoExit','-Command', cmd], { cwd, detached: true, stdio: 'ignore' })` 为每个服务开**独立控制台窗口**。
- `spawn` 直接返回 `.pid`——**这里不需要 pidfile**。
- 宿主 shell 同样优先 `pwsh`、否则 `powershell`。

### 3. 句柄模型（`core/types.ts`）

- `RunHandle.strategy` 联合类型新增 `'wt' | 'win'`。
- `RunService` 新增：
  - `pid?: number` —— 杀进程用的句柄。
  - `port?: number` —— stop 兜底用（避免 `stop.ts` 反查 state）。

`launch/index.ts` 的 `runLaunch` 增加 `wt`/`win` 分支：调用对应启动器，把返回的 pid 与 spec 的 port 写进 `RunService`。

### 4. stop / restart（`launch/stop.ts`）

- `wt`/`win` 策略下，stop 遍历目标服务，逐个按 PID 杀整棵进程树：

  ```
  taskkill /PID <pid> /T /F
  ```

- **兜底**：若某服务无 PID（pidfile 缺失/失效）但有 `port`，经
  `Get-NetTCPConnection -LocalPort <port>` → `OwningProcess` 找到属主并杀其进程树。无端口的 worker 依赖 pidfile（主路径）。
- 与 tmux 不同，**没有 "kill-session" 捷径**——`stop all` 就是遍历。
- `restart` 已是 stop + 重新启动（经 `mergeRun`），stop/launch 跑通后它自动可用。
- 沿用既有容错：句柄失效（execa 抛错）吞掉，视为已停。

### 5. `post_allocate` 的 shell 修复（`hooks/postAllocate.ts`）

把 `execa('sh', ['-c', cmd], …)` 换成 `execa(cmd, { …, shell: true })`。execa 的 `shell:true` 在 Unix 用 `/bin/sh`（行为不变）、在 Windows 用 `cmd.exe`——**两者都支持 `&&`**。一行级修复，无需平台分支。

### 6. 路径/句柄 bug 清扫

- `launch/tmux.ts`：`first.cwd.split('/').pop()` → `path.basename(first.cwd)`（Windows 反斜杠路径会坏；tmux 在 Windows 不用，但这是真实正确性 bug）。
- grep 全代码库其余 `/`-字面量路径操作并修。`config/discover.ts` 已正确（`node:path`）；providers 是网络客户端（无影响）。

### 7. 测试 + 文档

- `tests/launch/select.test.ts`：新增 `win+hasWt→wt`、`win+!hasWt→win`。
- 新增 `tests/launch/wt.test.ts` / `tests/launch/win.test.ts`：断言构建出的 `wt` 命令与 `spawn` 参数（mock `execa` / `child_process`）。
- `tests/launch/stop.test.ts`：新增 PID→`taskkill` 用例与 port→`Get-NetTCPConnection` 兜底用例。
- `post_allocate` 测试：断言用了 `shell:true`。
- README：新增 Windows 章节（wt vs 独立窗口、stop 语义、PowerShell 5.1 下 `command` 覆盖里 `&&` 的限制）。CHANGELOG 加 `0.0.10` 条目 + 版本号 bump。

## 已知限制（需在文档明示）

1. 服务 **`command` 覆盖**里用 `&&` 在 Windows 上需要 PowerShell 7（`pwsh`）；内置默认命令都是单条命令，所以这只在「自定义覆盖 + 仅有 5.1」时才会咬人。
2. `wt` 下被停掉的 pane 会显示 "process exited" 但 pane 留着，需用户手动关（与 `kill-pane` 前的死 tmux pane 一样）——纯属观感。

## 非目标（YAGNI）

- 不为 Windows 做进程守护 / 崩溃重启 / 健康检查（与现有 `bk start` 职责边界一致）。
- 不支持 cmd-only（无任何 PowerShell）的极端环境——Windows 一律自带 `powershell.exe` 5.1。
- 不改资源层、配置层、状态层的任何跨平台已正确的代码。
