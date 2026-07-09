# wt 策略修复设计：均匀网格 + 命令载体（wt Grid Fix Design）

> 状态：已批准（brainstorming → writing-plans）
> 日期：2026-07-09

## 背景

0.0.10 发布的 Windows 支持在真实 Windows 机器（Windows Server 2025、WT 1.24、仅 PowerShell 5.1）上做端到端验证时，发现 `wt` 策略存在两个 bug。验证方法：临时 lab 项目（10 个 vite service、每服务独立 port_base），以真实 `bk allocate/start/stop` 与 harness 复现逐一扫描 k=2..10 并截图取证。

**Bug A（致命——0.0.10 的 `wt` 策略从未真正启动过服务）：**
`wt.ts` 的 `paneScript` 生成 `$PID | Out-File -Encoding ascii '<pidfile>'; <命令>`，其中的 `;` 未按 WT 命令行语法转义（WT 要求字面分号写作 `\;`）。`wt` 把 `-Command` 字符串在 `;` 处拆成多个子命令：

- 前半（写 pidfile 的 powershell）成为一个闲置 pane——pidfile 被写入；
- 后半（真正的服务命令）被当成**独立 tab 的可执行文件**启动 → `0x80070002 系统找不到指定的档案`。

因为 pidfile 有内容，`runWt` 拿到 PID、`bk start` exit 0 **假成功**。现有单测只断言 argv 数组形状，结构上无法覆盖「WT 对合并后命令行的再解析」这一层。

**Bug B（布局）：**
`buildWtArgs` 用 `new-tab` + 重复裸 `split-pane`（auto 方向、无 `--size`）。WT 语义是每次切割**当前聚焦（=最新）pane**，面积按 1/2、1/4、1/8…几何塌缩：

- k=4 时已是 50/25/12.5/12.5；k≥5 末尾 pane 仅剩几字符宽，不可用；
- k=10 时第 9、10 个 split 触及 WT 最小 pane 尺寸而失败，**对应服务根本不启动**（实测 8/10 存活）。

## 实测数据（决策依据）

| 场景 | 结果 |
|------|------|
| 瀑布式（现状），k=2..9 | 服务全活，但布局塌缩、k≥5 末尾 pane 不可读 |
| 瀑布式（现状），k=10 | **8/10 存活**，第 9、10 个 split 失败 |
| 网格构造（本设计），k=6 | 完美 3 列 × 2 行等分，6/6 存活 |
| 网格构造（本设计），k=10 | 4 列 [3,3,2,2]，**10/10 存活**（默认窗口尺寸） |
| `-ExecutionPolicy Bypass -File` 启动脚本 | pidfile 正常写入、服务正常启动（RemoteSigned 策略机器实测） |

## 决策摘要（来自 brainstorming）

1. **Bug A 修法**：pane 命令载体从内嵌 `-Command` 字符串改为**每服务一个 .ps1 启动脚本** + `-File`（选项 (b)）。一行转义 `;`→`\;`（选项 (a)）被否决：只堵 `;`，`"`、`&` 等整类元字符地雷仍埋在 execa→WT→PowerShell 三层引号里（iterm 在 0.0.7 踩过同类坑）。
2. **Bug B 修法**：复用 iterm 的 planGrid 网格几何（用户明确要求：4→2×2、6→2×3 这类按数量预算的均匀网格），翻译成 WT 的「聚焦相对」构造序列。
3. 不建常驻 E2E 套件；本次真机验证记录作为证据留档。

## 架构

改动集中在 `src/launch/wt.ts`，外加一个几何抽取（`itermGrid.ts` → 共用模块）。stop/restart、`win.ts`、`selectStrategy`、hooks、资源/配置/状态层全部不动。

### 1. 网格形状抽取（新增 `src/launch/grid.ts`）

从 `itermGrid.planGrid` 抽出形状计算为共用纯函数：

```
gridShape(n): number[]   // colCounts，长度即列数
  cols = ceil(sqrt(n)); rows = ceil(n / cols)
  fullCols = n - cols * (rows - 1)
  colCounts[c] = c < fullCols ? rows : rows - 1   // 列优先填充
```

`planGrid` 改为调用 `gridShape` 取形状，其余（bisect、session id 寻址）不动——**iterm 行为零变化**。

### 2. pane 启动脚本（`wt.ts`）

- 新增 `launcherScriptFor(spec)`：与 `pidFileFor` 同 key、同目录（`<tmp>/bk-run/<key>.ps1`），每次 start 覆写。内容两行：

  ```powershell
  $PID | Out-File -Encoding ascii '<pidfile>'
  <服务命令>
  ```

  pidfile 路径按 PowerShell 单引号规则转义（`'` → `''`）。服务命令原样落盘（与今日 `-Command` 尾部语义一致，仍由 PowerShell 解析）。
- pane 命令固定为：`<psHost> -NoExit -ExecutionPolicy Bypass -File <脚本路径>`——wt argv 中不再出现任何用户命令文本。`-ExecutionPolicy Bypass` 兼容 Restricted 默认策略机器，`pwsh`/`powershell` 通用。

### 3. 网格构造序列（`buildWtArgs` 重写）

WT 无 pane 寻址（planGrid 的 target-id 模型不可直译），但 `split-pane` 作用于聚焦 pane、切后焦点移到新 pane，且有 `move-focus`。构造顺序：

1. `new-tab` = 格 (col 0, row 0)；
2. 左→右切等宽直列：c = 1..cols-1 依次 `split-pane -V --size (cols-c)/(cols-c+1)`，命令 = 第 c 列首格服务；
3. 最右列→左：列内 r = 1..cnt-1 依次 `split-pane -H --size (cnt-r)/(cnt-r+1)` 由上而下切行；切完一列 `move-focus left` 进入左邻列（此时左邻列必为单一整列 pane，方向无歧义）。

服务→格子按**列优先**指派（与 iterm 一致）：service k → (c, r)，其中 c、r 由 `colCounts` 前缀和反查。wt argv 的子命令顺序 ≠ 服务下标顺序，由该映射保证每个 pane 拿到正确服务。

每个 pane 附 `-d <spec.cwd>` 与 `--title <服务名>`（标题可能被 shell 自身标题覆盖，尽力而为）。`--size` 值格式化为 4 位小数。

`runWt` 流程不变：清旧 pidfile →（新增）写启动脚本 → 单条 `wt` 调用 → 轮询 pidfile 收 PID。

### 4. 句柄与 stop（不动）

pidfile→PID→state→`taskkill /T /F`→端口兜底这条链在真机验证中工作正常（k=2 实测：PID 记录、杀树、幂等）。`RunHandle`/`RunService` 类型、`stop.ts`、`restart` 全部不动。

## 测试

- 新增 `tests/launch/grid.test.ts`：`gridShape` —— 2→[1,1]、3→[2,1]、4→[2,2]、6→[2,2,2]、7→[3,2,2]、10→[3,3,2,2]；n=1→[1]。
- 改写 `tests/launch/wt.test.ts`：
  - `buildWtArgs` k=1（仅 new-tab）、k=2、k=6：断言子命令序列（`-V`/`-H`/`--size` 值/`move-focus left` 位置/`-File` 结构），断言 argv 不含用户命令文本，且 `;` 仅作为顶层子命令分隔符出现、不出现在任何单一参数内部；
  - 启动脚本内容：pidfile 行 + 命令行、单引号路径转义个案；
  - 服务→pane 指派：k=5（[2,2,1]）验证列优先映射。
- `runWt` pidfile 轮询逻辑不变，现有相关断言随签名微调。
- **mock 盲区声明**：WT 对合并命令行的再解析、pane 最小尺寸行为无法用 mock 覆盖；本设计的两处修复均以真机验证取证（见「实测数据」）。回归时需人工在 Windows 机器重跑冒烟（allocate → start → 目测网格 → stop）。

## 文档 + 版本

- CHANGELOG 新增 `0.0.11`：
  - Fixed：wt 策略 `-Command` 内嵌 `;` 被 WT 拆分导致服务从未启动（假成功）；改为每服务 .ps1 启动脚本。
  - Fixed：wt 策略瀑布式对半分屏导致 pane 塌缩、多服务时 split 失败；改为与 iTerm 一致的均匀网格（列优先）。
- README Windows 章节：网格布局描述（4→2 列 × 2 行、6→3 列 × 2 行、10→4 列 [3,3,2,2]）、`move-focus` 需较新 WT（≥1.7，2021 年后版本均满足）、pane 标题尽力而为备注。
- `package.json` 版本 bump 0.0.10 → 0.0.11。

## 已知限制（文档明示）

1. pane 数极大时 WT 最小尺寸仍会拒绝 split，对应服务不启动（默认窗口尺寸实测 10 pane OK）。服务更多时可在 WT 设置中调大默认启动窗口尺寸（`initialCols`/`initialRows`）；`bk start` 每次开新窗口，放大现有窗口对下次启动无效。
2. 被 stop 的 pane 显示 "process exited" 但 pane 留存，需手动关窗（沿用 0.0.10 已知限制，纯观感）。
3. 服务 `command` 覆盖里用 `&&` 在仅有 PowerShell 5.1 的机器上不可用（沿用 0.0.10 已知限制；载体改 .ps1 不改变该语义）。

## 非目标（YAGNI）

- 不控制窗口尺寸/位置（不传 `-M`/`--pos`/`--size` 窗口级参数）。
- 不做 pane 关闭/复用（`closeOnExit` 等属用户 WT 配置域）。
- 不建常驻 Windows E2E 测试套件。
- 不动 `win` 独立窗口策略与非 Windows 策略。
