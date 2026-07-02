# SpringBoot service 支持（injectionMode 与启动参数注入）

- 日期：2026-07-02
- 状态：设计已批准，待写实现计划

## 背景与问题

bk 解决的是本地并行启动多 worktree 项目的资源隔离问题。现有 service 类型（django/fastapi/vite/arq/celery）共享同一套注入哲学：

- bk 只往 service 目录 `.env` 写**动态隔离标识**（`BK_DB_NAME`/`BK_REDIS_DB`/`BK_MINIO_BUCKET`），主机/端口/账号密码等**共享静态连接信息留在开发者自己的 `.env` secrets**（块外，bk 不碰）。
- 监听端口不进 `.env`，走启动命令参数（`defaultStartCommand` 里填 `{port}`）。
- 插值只支持一种 token：`{<service>.port}`。

SpringBoot 打破了这些前提：

1. **默认不读 `.env`**——`.env` 注入路线对它无效。
2. **没有"开发者已备好 secrets `.env`"的约定**——连主机/端口/账号密码都可能需要 bk 提供。
3. **`application.yml` 属性结构因项目而异**——bk 无法可靠预知，不能靠生成覆盖文件来注入。

同时暴露一个既有设计债：`defaultStartCommand(svc, port?)` 的 `port` 参数是 `names.ports[svc.name]` 的冗余复制，破坏 SSOT。

## 方案权衡（两种注入路线）

### 方案 A：生成 `application-bk.yml` + 激活 `bk` profile

往 service 目录写 bk 托管的 `application-bk.yml`，启动加 `--spring.profiles.active=bk` 覆盖 datasource/redis。

- ✅ profile 是 Spring 原生机制，开发者熟悉。
- ❌ **结构耦合**：要写出正确覆盖，bk 必须预知项目属性路径与 JPA/MyBatis 差异——正是"结构因项目而异"的软肋。
- ❌ 往源码树写**整个文件**，侵入性大于 `.env` 标记块，需 gitignore + 托管。
- ⚠️ base yml 若硬编码 `spring.profiles.active` 或用 profile group 会打架。
- ⚠️ 值是 bk 分配值的副本，需保持同步。

### 方案 B：启动参数注入（采纳）

把连接信息作为命令行参数 / `-D` 系统属性 / 环境变量直接喂给进程。

- ✅ **优先级最高**：命令行参数在 Spring 属性解析里压过 application.yml 任意值，**与项目 yml 结构解耦**。
- ✅ **不往源码树写任何文件**，SSOT 最强（值直接来自 bk 分配结果 + infra）。
- ✅ 与本设计的 `injectionMode: startupArgs` + token 插值天然对应。
- ⚠️ 命令行会长；密码进 `ps`——但 README 已声明凭据是"本地可丢弃 dev 实例"明文，可接受。

**结论：采纳方案 B。** 命令行参数最高优先级且与 yml 结构无关，直接化解结构差异问题。

## 设计

### 1. `bk_config.yml` schema 变更

`ServiceType` 增加 `springboot`。每个 service 新增/调整字段：

```yaml
services:
  order-service:
    type: springboot
    dir: order-service          # 一模块一 service，各自目录
    port_base: 10200
    injectionMode: startupArgs  # 可省；按 type 推导，可显式覆盖
    startCommand:               # 新增：customStartCommand，命令+参数数组
      - mvn
      - spring-boot:run
      - -Dspring-boot.run.arguments=--server.port={self.port} --spring.datasource.url=jdbc:postgresql://{infra.postgres.host}:{infra.postgres.port}/{db.name}
    envs:                       # startupArgs：作为进程环境变量注入
      SPRING_DATASOURCE_USERNAME: "{infra.postgres.username}"
      SPRING_DATASOURCE_PASSWORD: "{infra.postgres.password}"
```

| 字段 | 规则 |
|---|---|
| `injectionMode?` | `'dotEnv' \| 'startupArgs'`。可省，缺省按 type 推导：django/fastapi/vite/arq/celery→`dotEnv`；springboot→`startupArgs`。显式写则覆盖。 |
| `startCommand?: string[]` | 新增 customStartCommand。与旧 `command: string` **二选一**，同时给报 `CONFIG_INVALID`。元素支持 token 插值。 |
| `envs`（`dotEnv`） | 现状：写进 service 目录 `.env` 标记块。**省略 → 默认 `BK_` 那套**。 |
| `envs`（`startupArgs`） | launch 时注入**进程环境变量**，不写文件。**省略 → 不注入任何环境变量**（不套 `BK_`，springboot 不认识 `BK_*`）。 |

**载体分工模型**（三种载体各有归属，bk 不猜 runner）：

- 命令行参数 / `-D` 系统属性 → 写进 `startCommand` 数组元素，用 token 插值，位置由用户掌控（`-jar` 前后、mvn `arguments` 里都行）。
- 进程环境变量 → 写进 `envs`（key=大写环境变量名），bk 启动前注入进程环境。

改动点：`src/core/types.ts` 的 `ServiceType`、`ServiceConfig`（加 `injectionMode?`、`startCommand?`）；`src/config/load.ts` 透传新字段并校验（`startCommand` 为字符串数组；与 `command` 互斥）。

### 2. 统一 token 解析器

`src/inject/interpolate.ts` 现只认 `{<svc>.port}`。扩展为作用于上下文 `ResolveContext = { self, names, infra }` 的通用解析器：

| token | 解析为 | 来源 |
|---|---|---|
| `{self.port}` | 本 service 分配端口 | `names.ports[self.name]` |
| `{<svc>.port}` | 指定 service 端口（保留现状） | `names.ports[svc]` |
| `{db.name}` | 本套 PG 库名（如 `foo_2`） | `names.database` |
| `{redis.db}` / `{redis.prefix}` | 本套 redis 隔离标识 | `names.redisDb` / `redisPrefix` |
| `{minio.bucket}` | 本套桶名 | `names.bucket` |
| `{infra.postgres.host\|port\|username\|password}` | 共享 PG 静态连接 | `infra.postgres.*` |
| `{infra.redis.host\|port}` | 共享 redis | `infra.redis.*` |
| `{infra.minio.endpoint\|access_key\|secret_key}` | 共享 minio | `infra.minio.*` |

- **作用域**：`startCommand` 数组每个元素、`envs` 值、旧 `command`（`{port}` 保留为 `{self.port}` 的向后兼容别名）。
- 引用不存在的 service / 无 `port_base` / infra 缺该项 → `CONFIG_INVALID`，带 remediation（点明哪个 token、在哪个 service）。
- `interpolateEnvs` 退化为该解析器的薄封装。
- "不需要的值即使 infra 有也不拼接"由此天然实现：解析器只替换用户实际引用的 token，springboot adapter 自身不组装 datasource。

### 3. injectionMode 的 launch 期机制

`startupArgs` 要把 `envs` 作为**进程环境变量**注入、且 `startCommand` 是数组。难点：环境变量前缀与数组→命令串的引号**因目标 shell 而异**（sh vs PowerShell），而 shell 在 `buildLaunchSpecs` 时未定。方案：**LaunchSpec 携带结构化数据，shell 相关渲染下沉到各 launcher。**

`src/launch/index.ts` 的 `LaunchSpec` 调整：

```ts
interface LaunchSpec {
  name: string; cwd: string; port?: number
  command?: string              // dotEnv：现状 ready shell 串（零改动、零风险）
  argv?: string[]               // startupArgs：已插值的 命令+参数（未加引号）
  env?: Record<string, string>  // startupArgs：已插值的进程环境变量
}
```

各 launcher：有 `argv` 就按自己 shell 渲染 `(env, argv)`，否则用 `command`（dotEnv 路径字节不变）：

| launcher | shell | env 前缀 | argv 拼接 |
|---|---|---|---|
| tmux | posix sh | `K='v' ` 前缀 | `'arg'` 单引号转义拼接 |
| wt | PowerShell | `$env:K='v'; `（进 paneScript） | `& 'exe' 'arg'` 调用算子 |
| win | PowerShell | 走 `spawn` 的 `env` 选项（直接 spawn，最干净） | `& 'exe' 'arg'` |
| print | posix 展示 | 显示 `K=v` 行 | 展示拼好的命令 |

含空格的元素（如 `-Dspring-boot.run.arguments=--server.port=X --spring...`）由各 shell 引号器整体括起，不被拆断。需为两个目标 shell 各写一个引号器（posix / PowerShell），并加测试覆盖含空格/引号的元素。

`buildLaunchSpecs`：按 `injectionMode` 分流——dotEnv 走现状产 `command`；startupArgs 插值 `startCommand`→`argv`、插值 `envs`→`env`。

### 4. `defaultStartCommand` 签名重构（去冗余 port）

`FrameworkAdapter` 调整：

```ts
interface FrameworkAdapter {
  type: ServiceType
  defaultInjectionMode: 'dotEnv' | 'startupArgs'   // 新增：type 默认注入载体
  detect(dir: string): boolean
  defaultStartCommand(svc: ServiceConfig, rc: ResolveContext): string  // 去掉裸 port
  envVars(names: ResourceNames): Record<string, string>  // 仅 dotEnv 模式用
}
// ResolveContext = { self: ServiceConfig; names: ResourceNames; infra: InfraConfig }
```

- django/fastapi/vite：改从 `rc.names.ports[svc.name]` 取端口，行为不变。
- **springboot 的 `defaultStartCommand` 抛 `CONFIG_INVALID`**：mvn/gradle/jar 三种跑法 + 模块布局各异，没有可靠默认——要求用户配 `startCommand`（如 fastapi 要求 `app`）。

### 5. springboot 检测 + 多模块 `bk init`

**`detect(dir)`**：`pom.xml` 含 `org.springframework.boot`（parent 或 starter）**且 `<packaging>` 非 `pom`**（排除父聚合模块）；或 `build.gradle(.kts)` 引用 `org.springframework.boot`。满足即 `springboot`。

**多模块**：`buildConfigDraft` 已逐子目录 `detectType`、每个命中的模块自动成一个 service（`dir`=模块名、`port_base` 递增 `base += 100`）。父聚合 pom 因 `detect` 返回 false 被跳过。无需改 init 的扫描骨架。

**ORM 子检测（仅 init 起草用）**：读该模块 pom/gradle——`spring-boot-starter-data-jpa`→jpa；`mybatis-spring-boot-starter`/`org.mybatis`→mybatis。据此生成不同**注释草稿**（datasource 三件套相同；差异只体现在注释提示的 `spring.jpa.*` vs `mybatis.*`，bk 运行期不看 ORM）：

```yaml
  order-service:
    type: springboot
    port_base: 10200
    dir: order-service
    # startCommand:                       # TODO 选一种跑法（mvn / gradle / java -jar）
    #   - mvn
    #   - spring-boot:run
    #   - -Dspring-boot.run.arguments=--server.port={self.port} --spring.datasource.url=jdbc:postgresql://{infra.postgres.host}:{infra.postgres.port}/{db.name}
    # envs:                               # TODO 需要走环境变量的（如密码）
    #   SPRING_DATASOURCE_USERNAME: "{infra.postgres.username}"
    #   SPRING_DATASOURCE_PASSWORD: "{infra.postgres.password}"
    #   # 侦测到 MyBatis：mapper 等非连接属性 bk 不碰，按需自填
```

## 非目标 / YAGNI

- 不实现方案 A（profile yml 生成）。
- bk 运行期不解析 application.yml、不区分 JPA/MyBatis（ORM 检测只服务 init 起草）。
- 不为 springboot 提供默认启动命令（必须配 `startCommand`）。
- 不做 mvn/gradle/jar 的 runner 自动探测——载体位置由用户在 `startCommand` 里掌控。

## 测试要点

- token 解析器：各类 token（self.port/db.name/infra.*）成功解析；缺失引用报 `CONFIG_INVALID`；`{port}` 向后兼容别名。
- schema 校验：`startCommand` 与 `command` 互斥；`injectionMode` 缺省按 type 推导。
- launcher 引号器：posix 与 PowerShell 各覆盖含空格/引号的 argv 元素；dotEnv 路径 `command` 不回归。
- `defaultStartCommand` 重构后 django/fastapi/vite 命令不变；springboot 无 `startCommand` 时报错。
- detect：springboot pom（starter/parent）命中、父聚合 pom（`packaging=pom`）跳过、gradle 命中。
- init：多模块 repo 每个 springboot 模块各生成一个 service、端口递增、ORM 注释草稿正确。
