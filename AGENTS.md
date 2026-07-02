This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

BookKeeper（`bk`）是一个 **strongly opinionated** 的 CLI（Node/TS），管理「在同一台机器上并行运行多个 git worktree」所需的本地逻辑资源（端口 / 数据库 / Redis db 或 key 前缀 / MinIO 桶）。它**不安装也不照看基础设施软件本身**（Postgres/Redis/MinIO 进程由用户预装、长期运行，bk 只读连接信息），**不管资源内容**（建表/seed 是项目自己的事），**不做进程守护**（`bk start` 只派发，崩溃不重启、不健康检查，但会记句柄供 `stop`/`restart` 用）。

一个 worktree = 一套**资源集**，由单一整数 `N`（从 1 起）驱动所有命名（`port_base+N`、`<project>_<N>`、`<project>-<N>` 等）。资源是**耐久资产**：`allocate` 领一套（池中有空闲就复用，没有就 on-demand 建），`deallocate` 退回池子（保留数据），`destroy <n>` 才真正销毁（`DROP DATABASE`/删桶，不可逆）。bk **绝不自动 destroy**。

详细的用户面语义、命令用法、`bk_config.yml` 字段见 `README.md`——这份文件只讲**给开发者看**的架构与约定。

## 开发命令

```bash
npm run build       # tsup 打包到 dist/（ESM，带 shebang，产出 bin: dist/cli/index.js）
npm run dev         # tsx 直接跑源码：tsx src/cli/index.ts <args...>
npm test            # vitest run（一次性跑全部）
npm run test:watch  # vitest 监听
npm run typecheck   # tsc --noEmit（CI 前必过；项目 strict 模式）
```

跑**单个**测试文件或用 `-t` 过滤：

```bash
npx vitest run tests/core/allocator.test.ts
npx vitest run tests/cli -t "幂等"
```

### 测试分层（重要）

+ **单元/流程测试**（绝大多数）：用 `tests/helpers/fakeProvider.ts` 替掉真实 infra provider，避免连真实 DB/Redis/MinIO。**状态隔离靠 `BK_HOME` 环境变量**——每个 `beforeEach` 把 `process.env.BK_HOME` 指向 `mkdtempSync` 的临时目录，让 `~/.bookkeeper/<project>/` 落进 tmpdir。新增任何涉及 state 的测试都要这么做。
+ **集成测试**（`tests/providers/*.integration.test.ts`）：用 **testcontainers** 起真实 Postgres/Redis/MinIO 容器，需本机有 Docker。文件开头用 `describe.runIf(hasDocker())`（`tests/helpers/docker.ts`）守卫——**没 Docker 时静默跳过**，不会让 CI 变红。改 provider 实现时优先跑这几个。

## 代码架构

### 分层与一次 allocate 的数据流

```
src/cli/commands/*.ts      commander 子命令注册 + runCommand 包错误（入口）
  └─ src/cli/context.ts     loadCtx(): discoverProjectRoot(cwd) 向上找 bk_config.yml → loadConfig()
      └─ src/core/          纯逻辑，无 IO 副作用（allocator/numbering/deallocator/destroyer/run）
          ├─ src/providers/  资源类型适配器（port/postgres/redis/minio）
          ├─ src/frameworks/ 框架适配器（django/fastapi/vite/arq/celery）
          ├─ src/inject/     .env 标记块写入 / 占位符插值 / .gitignore
          ├─ src/hooks/      post_allocate 钩子执行
          └─ src/launch/     start/stop/restart 的 tmux/iterm/print 派发
state: src/state/store.ts   读写 ~/.bookkeeper/<project>/state.json（唯一真相源）
```

典型流程（`doAllocate`，`src/cli/commands/allocate.ts`）：在 `withState` 文件锁内 → `resolveSet`（挑号 + 探活跳号）→ `provisionSet`（建库/建桶，失败按 done 反向 destroy 回滚）→ `planNames`（每个 provider 的 `plan` 合成 `ResourceNames`）→ 写 state 的 `SetRecord` → `writeServiceEnvs` 写 `.env` 块。出锁后（`.env` 已落盘）才跑 `post_allocate` 钩子——**钩子刻意在持锁之外**，避免长时间持锁，且复用/幂等命中时不触发。

### `ResourceProvider` 接口（`src/providers/types.ts`）—— 扩展资源类型的位置

```ts
plan(n, ctx)      → Partial<ResourceNames>   // 纯计算命名（端口/库名/桶名），无副作用
probe(n, ctx)     → Promise<boolean>         // true=号可用，false=撞了→allocator 跳号
provision(n, ctx) → Promise<void>            // 真正创建（CREATE DATABASE / makeBucket）
destroy(n, ctx)   → Promise<void>            // 真正销毁
```

`src/providers/registry.ts` 的 `activeProviders(ctx)` 按 `ctx.config.infra` 里声明了哪些 infra 来**动态拼装** provider 列表（port 永远在；postgres/redis/minio 仅当配置里有才加）。`resolveSet`/`provisionSet`/`planNames` 都接受这组 provider 列表，因此**测试可注入 `fakeProvider`**。新增一种基础设施 = 新 provider + 在 registry 里条件注册。

### `FrameworkAdapter` 接口（`src/frameworks/types.ts`）—— 扩展服务框架的位置

```ts
type: ServiceType
detect(dir)                                     // bk init 侦测项目类型（看 manage.py / vite.config / pom.xml 等）
defaultInjectionMode                            // 'dotEnv'（写 .env）| 'startupArgs'（额外把 envs 经 {args} 拼进启动命令）
defaultStartCommand(svc, dir)                   // 返回带占位符的启动命令模板（{port}/{args} 等），由 launch 统一插值——不再 bake 端口
envVars(names)                                  // envs 省略时的默认回退（后端产 BK_*，vite 返回 {}）
```

`src/frameworks/registry.ts` 的 `ALL` 数组是**所有适配器的注册表**：`adapterFor(type)` 查表，`detectType(dir)` 用第一个 `detect` 命中的。**新增一个框架 = 加 `src/frameworks/<name>.ts` + `ServiceType` 联合类型加字面量 + `ALL` 数组注册**，三处。后端框架共享 `backendEnv.ts` 的 `backendEnvVars`（产出 `BK_DB_NAME`/`BK_REDIS_DB`/`BK_MINIO_BUCKET`）；无端口 worker（arq/celery）不写 port_base、不占独立资源。新框架还需声明 `defaultInjectionMode`（springboot 是首个 `startupArgs`）；`{port}`/`{infra.*}`/`{args}` 占位符由 `src/inject/interpolate.ts` 的统一插值器解析。

### State store（`src/state/store.ts`）

机器级、按 `project_name` 维度一份：`~/.bookkeeper/<project>/state.json`（`BK_HOME` 可覆盖根，测试用）。是**分配关系的唯一真相源**，与代码仓库解耦（不进 git）。所有读写都走 `withState(project, fn)`——它用 `proper-lockfile` 对 `~/.bookkeeper/<project>/lock` 加锁（重试 50 次），fn 内可放心改 `state.sets`，函数返回前 `atomicWrite`（写 `.tmp` 再 `rename`）。**绝不要绕过 `withState` 直接读写 state 文件**。`SetRecord` 里 `resources` 字段把 infra 特殊键（`postgres`/`redis`/`minio`）与各 service 的 `{ port }` 混在同一对象，遍历时注意区分。

### `.env` 注入约定（`src/inject/env.ts`）

bk 只动 `# >>> bk managed >>>` … `# <<< bk managed <<<` **标记块**内，块外的 secrets **绝不触碰**。`writeEnvBlock` 先 `stripBlock`（正则按 BEGIN/END 标记删旧块）再追加新块，因此**幂等**。每个 service 的 `.env` 写在它自己的 `dir` 下（缺省为 worktree 根）；同目录多个 service 合并 env 需求。前端（vite）只写配置里 `envs` 声明的变量（支持 `{<服务名>.port}` 占位符，`src/inject/interpolate.ts` 插值），**不写任何 `BK_*`**。改注入逻辑后跑 `tests/inject/*`。

### launch（`src/launch/`）

`selectStrategy` 自动探测 **tmux（`$TMUX`）→ iTerm（darwin + `TERM_PROGRAM=iTerm.app`）→ print**，可 `--tmux/--iterm/--print` 强制。`buildLaunchSpecs` 把每个 service 的命令在其 `dir` 下构造好。tmux/iterm 成功后记录 `RunHandle`（iTerm 存每个 pane 的 session unique id，tmux 存 session + pane id）写回 state，`stop`/`restart` 据此操作；`print` 不记句柄（用户自己跑的进程 bk 不管）。`liveness.ts` 在 `start`/`stop` 前**探测句柄真实存活**（iTerm 查存活 session id、tmux 查存活 pane id），把手动关窗造成的**陈旧孤儿记录**清掉——这是 0.0.11 的关键修复，改 launch 时务必保留这套「不裸信任 state 标志」的语义。

## 关键约定

+ **ESM-only**：`package.json` 是 `"type": "module"`，tsconfig 用 `NodeNext` 模块解析。**所有相对 import 必须带 `.js` 后缀**（即使源文件是 `.ts`）——这是 NodeNext 的硬性要求，漏了会在运行时 `ERR_MODULE_NOT_FOUND`。
+ **错误处理**：业务错误一律 `throw new BkError(code, message, { remediation })`，code 取自 `src/core/errors.ts` 的 `Codes`（如 `CONFIG_INVALID`/`PORT_IN_USE`/`SET_NOT_FOUND`/`HOOK_FAILED`）。`cli/context.ts` 的 `runCommand` 统一捕获：打印 message + `[code]` + remediation 提示，`process.exitCode = 1`。**不要用裸 Error**，否则用户看不到 code 与修复建议。
+ **幂等是硬约束**：`allocate` 同目录重复调用必须复用既有 Set、不重 provision、不覆盖 `.env`；`stop`/`restart` 遇失效句柄必须静默跳过、不报错。新增命令时沿用这一风格。
+ **配置过滤**：`bk list` 与 allocate 幂等打印都**按当前 `bk_config.yml` 过滤**展示——只显示配置里仍声明的 service/infra。这是纯显示层，不改写 state、不动 `.env`。
+ **`bk_config.yml` 是项目根锚点**：`discoverProjectRoot` 向上遍历找它来定位 main 仓库根；bk 在任意 worktree 子目录里都能工作。

## 文档工作流（本仓库特有）

本仓库用 `docs/superpowers/` 管设计文档，遵循 **spec（设计）+ plan（实现计划）** 双文档、文件名带日期的约定：

+ `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md` —— 已确认的设计抉择与理由（**改契约前先读对应的 spec**）
+ `docs/superpowers/plans/YYYY-MM-DD-<slug>.md` —— 分 Task 的实现计划与 commit trailer 约定

做新功能前，先翻这两个目录看是否已有相关 spec/plan，并在其中记录设计决策（尤其涉及接口契约改动的，见上面的 springboot 示例）。变更发版在 `CHANGELOG.md` 追加条目（按版本号降序）。