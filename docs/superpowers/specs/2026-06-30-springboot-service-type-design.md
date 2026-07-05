# Spring Boot service 类型 设计文档

- 日期：2026-06-30
- 状态：已确认设计，待实现
- 关联：`src/frameworks/*`（框架适配器）、`src/launch/index.ts`（启动命令构建）、`src/cli/commands/init.ts`（项目侦测）

## 目标

新增第 6 个框架适配器 `springboot`——bk 的**首个 Java/JVM 框架**，兑现 README「首批支持 Django、FastAPI、Vite……Java 后续再说」里预留的 Java 里程碑。

它是一个**有端口的 web 服务**（与 django / fastapi / vite 同类，不是无端口 worker）。落地点全部沿用现有模式：`ServiceType` 联合类型加一个字面量、`src/frameworks/springboot.ts` 新增适配器、`registry.ts` 的 `ALL` 数组注册。

## 背景与核心抉择：CLI 参数注入

Spring Boot 与现有框架有一个根本差异：**它原生不读 `.env`**。Vite 自动加载 `.env`，Python 靠 python-dotenv 惯例加载；Spring Boot 的原生配置面是 **`application.yml` + 环境变量 + 命令行参数**。

决策（已确认）：**端口与隔离标识一律走命令行参数**。理由——Spring Boot 的命令行参数**优先级最高**（高于 application.yml、高于环境变量），能干净地 override，且顺带绕开「Spring 不读 .env」的问题，无需项目引入 spring-dotenv 之类的第三方依赖。

由此带出一条不可避免的契约改动（见下节）：适配器要在生成命令时拿到已分配的资源名。

## 唯一的契约改动：`defaultStartCommand` 拿到资源名与服务目录

当前签名只拿到端口：

```ts
defaultStartCommand(svc: ServiceConfig, port?: number): string
```

要拼 DB名/Redis db/桶名进 CLI 参数，适配器必须拿到**已分配的资源名**与**服务所在目录**（后者用于侦测 build 工具）。扩展为：

```ts
defaultStartCommand(
  svc: ServiceConfig,
  port: number | undefined,
  names: ResourceNames,
  dir: string,          // 命令运行的绝对目录 = join(worktreeDir, svc.dir ?? '.')
): string
```

- `names` 由 `buildLaunchSpecs` 从 `set.resources` 构造透传——写 `.env` 用的就是这批值，start 时它在 `set.resources` 里已存在。
- `dir` 就是命令的 `cwd`，`buildLaunchSpecs` 本就按 `join(worktreeDir, s.dir ?? '.')` 算。
- 现有 5 个适配器签名加这两个参数、**忽略不用**——向后兼容；调用点仅 `launch/index.ts` 一处、命令测试一处。

**新增小助手 `setToResourceNames(set)`**：把已分配的 `SetRecord` 映射成 `ResourceNames`（allocate 时由 `planNames` 产出，start 时从持久化的 `set.resources` 重构）。映射关系：

```ts
function setToResourceNames(set: SetRecord): ResourceNames {
  const ports: Record<string, number> = {}
  for (const [svc, r] of Object.entries(set.resources)) {
    if (svc === 'postgres' || svc === 'redis' || svc === 'minio') continue  // 跳过 infra 特殊键
    if (r && typeof r === 'object' && 'port' in r) ports[svc] = (r as { port: number }).port
  }
  return {
    ports,
    database: set.resources.postgres?.database,
    redisDb: set.resources.redis?.db,
    redisPrefix: set.resources.redis?.prefix,
    bucket: set.resources.minio?.bucket,
  }
}
```

> 放置位置由实现计划决定（建议 `src/core/`，与 `SetRecord`/`ResourceNames` 相邻）。

## `detect`：是不是 Spring Boot 项目

```
pom.xml 存在 且 内容含 /spring-boot/                                   → true（Maven 风格）
或（build.gradle | build.gradle.kts）存在 且 内容含 /org\.springframework\.boot/  → true（Gradle 风格）
```

`/spring-boot/` 命中 `<parent>` 的 `org.springframework.boot`、`spring-boot-starter-*` 依赖、`spring-boot-maven-plugin`；`/org\.springframework\.boot/` 命中 Gradle 的 `id "org.springframework.boot"` 插件与 `org.springframework.boot:spring-boot-starter-*` 依赖。与 `detectType` 既有约定一致（`manage.py`→django、`vite.config`→vite）。

## `defaultStartCommand`：build 工具侦测 + CLI 参数

### build 工具择一（mvnw 优先）

```ts
function pickBuildTool(dir: string): 'maven' | 'gradle' {
  if (existsSync(join(dir, 'pom.xml'))) return 'maven'   // Maven 标记存在即 Maven（mvnw 优先）
  return 'gradle'                                        // 否则 build.gradle(.kts)
}
```

项目实际上不会同时有 `pom.xml` 与 `build.gradle`；「mvnw 优先」编码为「`pom.xml` 在即 Maven」。运行器优先用 wrapper：

```ts
const runner = tool === 'maven'
  ? (existsSync(join(dir, 'mvnw')) ? './mvnw' : 'mvn')
  : (existsSync(join(dir, 'gradlew')) ? './gradlew' : 'gradle')
```

Spring Boot 项目默认随附 wrapper，故 `./mvnw`/`./gradlew` 是常态；缺 wrapper 时回退裸命令。

### 隔离标识按存在性拼（镜像 `backendEnvVars` 的择一逻辑）

```ts
function buildSpringArgs(port: number, names: ResourceNames): string[] {
  const args = [`--server.port=${port}`]
  if (names.database)                 args.push(`--BK_DB_NAME=${names.database}`)
  if (names.redisDb !== undefined)    args.push(`--BK_REDIS_DB=${names.redisDb}`)
  else if (names.redisPrefix)         args.push(`--BK_REDIS_PREFIX=${names.redisPrefix}`)
  if (names.bucket)                   args.push(`--BK_MINIO_BUCKET=${names.bucket}`)
  return args
}
```

### 最终命令

```
# Maven
./mvnw spring-boot:run -Dspring-boot.run.arguments="--server.port={port} --BK_DB_NAME={db} --BK_REDIS_DB={n} --BK_MINIO_BUCKET={bucket}"

# Gradle
./gradlew bootRun --args='--server.port={port} --BK_DB_NAME={db} --BK_REDIS_DB={n} --BK_MINIO_BUCKET={bucket}'
```

要点：
- **端口必填**（web 服务）：缺 `port_base`（`port === undefined`）抛 `CONFIG_INVALID`，与 vite/django 一致。
- **隔离标识按存在性拼**：有 postgres 才加 `--BK_DB_NAME`；redis 走 db_number 加 `--BK_REDIS_DB`，走 key_prefix 加 `--BK_REDIS_PREFIX`；有 minio 才加 `--BK_MINIO_BUCKET`。
- 项目的 `application.yml` 用占位符引用这些动态标识，**静态连接信息（host/端口/账号）留在项目自己的配置里**——bk 只注入动态库名/桶名，理念不变：
  ```yaml
  spring:
    datasource:
      url: jdbc:postgresql://localhost:5432/${BK_DB_NAME}
    data:
      redis:
        database: ${BK_REDIS_DB}
  ```
  Spring Boot 命令行参数注册的是字面属性键（`--BK_DB_NAME=foo` → 属性 `BK_DB_NAME`），故 `${BK_DB_NAME}` 占位符可直接解析（与 env-var 风格的 underscore→dot relaxed binding 无关，占位符查找按字面键命中）。

### 引号安全性（已核实，无需新增转义）

Maven 用双引号（`-Dspring-boot.run.arguments="..."`，Maven 标准惯例），Gradle 用单引号（`--args='...'`，天然不与 iTerm 的双引号包裹冲突）。三种启动策略均正确处理：

- **iTerm**：`esc` 已把 `"` 转义为 `\"`（AppleScript 字符串安全）；单引号 `'` 在 AppleScript 字符串中无需转义。
- **tmux / print**：命令字符串交给 shell 解释，双/单引号按用户手敲的方式工作。

各 CLI 参数的值（端口号、`foo_2`、`foo-2`、redis db 号）均不含空格，无断裂风险。

## `envVars`：照写 `.env`（复用 `backendEnvVars`）

```ts
envVars: backendEnvVars,
```

往 service 目录的 `.env` 写 `BK_DB_NAME` / `BK_REDIS_DB` / `BK_MINIO_BUCKET`（与 django / fastapi / arq / celery 完全一致）。理由：

- **`post_allocate` 钩子要读**：钩子（如 `./mvnw flyway:migrate`）从注入的进程环境读 `BK_DB_NAME`，必须有（钩子 env 来自 `buildDirEnvs` → `adapterFor(...).envVars(names)`）。
- **与所有后端适配器一致**。
- 运行时送达以 **CLI 参数为主**（优先级最高），`.env` 是钩子 + 一致性 + 手动运行（若项目自行加 spring-dotenv）的副产物。两者同值、各司其职。

## `bk init`：侦测 + 生成草稿（不解析 application.yml）

`buildConfigDraft` 复用现有循环（`detectType` 已能识别 springboot）。侦测到 `springboot` 时写：

```yaml
  <name>:
    type: springboot
    port_base: 10000      # 沿用 10000 起步、每个 service +100 的现有约定
    dir: <侦测到的子目录>   # 根项目为 '.'
```

**不解析 `application.yml`/`properties`** 提取 infra——Spring 配置形式多（yml/properties、多 profile）、易出错；infra 用默认值，提示用户核对（与 django/fastapi init 同档：它们也只填 type/port_base/dir，不深挖 settings.py 的连接信息）。`bk init` 的成功提示文案已泛指「请审核 infra 凭据」，无需为 springboot 特改。

## 配套改动

- **`src/core/types.ts`**：`ServiceType` 加 `'springboot'`。
- **`src/frameworks/registry.ts`**：`ALL` 数组加入 `springboot`（导入 + 列表项）。
- **`src/frameworks/types.ts`**：`defaultStartCommand` 签名按上节扩展。
- **`src/frameworks/{django,fastapi,vite,arq,celery}.ts`**：5 个适配器的 `defaultStartCommand` 签名对齐（多收 `names`、`dir`，忽略不用；`vite`/`django` 现为 `(_svc, port)` 改为 `(_svc, port, _names, _dir)`）。
- **`src/launch/index.ts`**：`buildLaunchSpecs` 内构造 `names = setToResourceNames(set)`、`dir = join(worktreeDir, s.dir ?? '.')`，透传给 `defaultStartCommand`。
- **`README.md`**：
  - 默认启动命令表加 Maven / Gradle 两行（端口栏：需要）。
  - 理念段「Java 后续再说」→「已支持 Spring Boot（Maven/Gradle）」；补一句「本机需有 JDK」（bk 仍不管基础设施软件生命周期）。
  - 配置注入段补 Spring Boot 的 CLI 参数约定 + `application.yml` 占位符示例。
  - init 段补 springboot 侦测说明。
- **`CHANGELOG.md`**：新增条目（下一版本号）。

## 测试

### 新增 fixture

- **`tests/fixtures/springboot-proj/pom.xml`**：含 `spring-boot-starter-web` 依赖与 `spring-boot-maven-plugin`（验 Maven 侦测 + 命令）。
- **`tests/fixtures/springboot-proj-gradle/build.gradle`**：含 `id 'org.springframework.boot'` 插件（验 Gradle 侦测 + 命令）。

### 测试用例

- **`tests/frameworks/detect.test.ts`**：`springboot-proj` → `springboot`；`springboot-proj-gradle` → `springboot`。
- **`tests/frameworks/command.test.ts`**（`defaultStartCommand`，签名升级为带 `names`、`dir`）：
  - Maven fixture 目录 → `./mvnw spring-boot:run -Dspring-boot.run.arguments="--server.port={port} ..."`，且隔离参数按 `names` 存在性拼全/拼缺。
  - Gradle fixture 目录 → `./gradlew bootRun --args='--server.port={port} ...'`。
  - 缺端口（`port === undefined`）→ 抛 `CONFIG_INVALID`。
  - 隔离参数择一：`names.redisDb` 有 → `--BK_REDIS_DB`；仅 `redisPrefix` → `--BK_REDIS_PREFIX`；均无 → 两个都不出现。
  - 现有 5 个适配器的命令测试同步升级签名（多传 `names`、`dir`，断言不变）。
- **`tests/frameworks/env.test.ts`**：`springboot` 的 `envVars` 与 `django`/`fastapi` 同输出（复用 `backendEnvVars`）。
- **`tests/cli/init.test.ts`**：含 springboot fixture 子目录时，生成的草稿含 `type: springboot` + `port_base` + `dir`。

> 签名升级触及现有命令测试：所有 `adapterFor(...).defaultStartCommand(svc, port)` 调用补成 `defaultStartCommand(svc, port, names, dir)`。

## 不做（YAGNI）

- **Spring 的「无端口 worker」类似物**（Spring Batch / Cloud Task 等）：bk 不需要。`springboot` 就是单一 web 服务类型。
- **解析 `application.yml`/`properties` 自动提 infra**：形式多、易出错，留给用户核对。
- **JDK 安装/管理**：bk 不管基础设施软件生命周期（与 Postgres/Redis 同），README 仅补「本机需有 JDK」一句。
- **同时支持 Maven 与 Gradle 之外的构建工具**（Ant 等）：Spring Boot 现实只有这两种。

## 已否决的备选

- **`.env` + 项目侧 spring-dotenv**：要项目加第三方依赖，且 Spring 无此惯例。CLI 参数零依赖、更 Spring-native。
- **bk 在启动命令里 `source .env`**（`sh -c 'set -a; . ./.env; exec ./mvnw ...'`）：可行，但 CLI 参数优先级更高、更直接，且无需给 springboot 套特殊 shell wrapper（保持与其它框架「裸命令」一致）。
- **写 Spring 原生属性名**（如 `-Dspring.datasource.url=...` 或 `SPRING_DATASOURCE_URL`）：需 bake 主机/端口/账号，违反 bk「只写动态隔离、不碰静态连接信息」理念；且 DB 名无法用单个 Spring 属性表达。改用 `--BK_DB_NAME` 让项目 `application.yml` 在 URL 模板里引用，静态部分留在块外。
