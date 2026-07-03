# 达梦数据库（DM8）支持

- 日期：2026-07-03
- 状态：设计已批准，待写实现计划
- 关联：与 `2026-07-01-unified-injection-model-design.md` 的 `{infra.*}` 占位符体系直接对接（新增 `{infra.dameng.*}` 命名空间）
- 涉及代码：`src/providers/dameng.ts`（新）、`src/providers/registry.ts`、`src/core/types.ts`、`src/frameworks/backendEnv.ts`、`src/inject/interpolate.ts`、`src/cli/commands/list.ts`

## 背景与问题

Spring Boot 项目（尤其面向国内政企/信创场景）常需以达梦 DM8 作为关系型数据库。bk 当前只支持 postgres。需把达梦纳入 bk 的 infra 资源模型，让 worktree 能像领 postgres 库一样「领一个达梦资源」。

关键约束（与 postgres 不同）：

1. **隔离单元是 SCHEMA 而非 DATABASE**。达梦与 Oracle 同源，实例层是「一个库 + 多模式」，没有 postgres 那种轻量的 `CREATE DATABASE`。每个 worktree 分配一个独立 **schema**，所有 worktree **共享同一个连接用户**、连接串恒定——唯一随 worktree 变化的是 schema 名。
2. **Node 生态驱动**：bk 是 Node/TS，需自备驱动执行 CREATE/PROBE/DESTROY（与业务无关的纯资源管理）。采用达梦官方 npm 包 `dmdb`。
3. **标识符大小写**：达梦像 Oracle 会把不带引号的标识符折成**大写**。为避免大小写歧义，schema 名一律按**全大写**生成。

## 已否决的备选

- **复用 postgres 的 `database` 槽位 / `BK_DB_NAME`**：语义混淆（库名 vs schema 名），违背「`database` 字段特指库名」的现有约定，且阻断 postgres+达梦共存。
- **抽象通用 RDBMS 类型（`infra.rdbms: { vendor }`）**：postgres（database 隔离）与达梦（schema 隔离）模型不同，强行抽象属过度设计。
- **按用户(USER)隔离**：隔离更彻底但每个 worktree 一套连接凭证，连接串随 worktree 变、管理更重；schema 隔离更轻，已能满足。
- **按表名前缀 / 表空间隔离**：不自然、清理麻烦。

## 核心模型

达梦作为**独立、可选的 infra 类型**，与 postgres/redis/minio 平级、正交。不配则不启用（registry 按声明动态注册，沿用现有约定）。

```yaml
infra:
  dameng:
    host: 127.0.0.1
    port: 5236            # DM 默认端口
    username: SYSDBA      # 共享连接用户，所有 worktree 复用
    password: "***"
```

- **隔离语义**：`provision` 在共享用户下建一个 schema（`CREATE SCHEMA`）；`destroy` 级联删 schema（`DROP SCHEMA ... CASCADE`）。连接凭证恒定，应用凭注入的 schema 名切换当前模式。
- **命名**：`<PROJECT>_N` 全大写（如项目 `foo` → `FOO_1`、`FOO_2`），与 postgres 的 `<project>_<n>` 小写风格并存、各自独立。project_name 需为合法 DM 标识符字符（字母/数字/下划线）。

## 类型与 State 改动（`src/core/types.ts`）

```ts
export interface InfraConfig {
  postgres?: { host: string; port: number; username: string; password: string }
  redis?: { host: string; port: number; isolation?: RedisIsolation }
  minio?: { endpoint: string; access_key: string; secret_key: string }
  dameng?: { host: string; port: number; username: string; password: string }   // 新增
}

export interface ResourceNames {
  ports: Record<string, number>
  database?: string
  redisPrefix?: string
  redisDb?: number
  bucket?: string
  dmSchema?: string      // 新增：达梦 schema 名
}

export interface SetRecord {
  status: 'allocated' | 'free'
  owner: { worktree: string; branch: string } | null
  resources: {
    [service: string]: { port: number } | undefined
  } & {
    postgres?: { database: string }
    redis?: { prefix?: string; db?: number }
    minio?: { bucket: string }
    dameng?: { schema: string }    // 新增
  }
  created_at: string
  run?: RunRecord
}
```

## Provider 实现（`src/providers/dameng.ts`，新增）

仿 `postgres.ts` 的 `withClient` 模式：用 `dmdb` 连共享用户，连接失败抛 `BkError(INFRA_UNREACHABLE, ..., { recoverable: false, remediation: '达梦起了吗？' })`，风格对齐 postgres。

```ts
export function createDamengProvider(): ResourceProvider {
  return {
    kind: 'dameng',
    plan: (n, ctx) => ({ dmSchema: schemaName(n, ctx) }),   // 纯计算：大写名
    probe: (n, ctx) => withClient(ctx, async (c) => {
      // 查 DM 系统目录：schema 不存在 → true(可分配)，存在 → false(撞了→跳号)
      const r = await c.execute(querySql, [schemaName(n, ctx)])
      return r.rows?.length === 0
    }),
    provision: (n, ctx) => withClient(ctx, async (c) => {
      await c.execute(`CREATE SCHEMA "${schemaName(n, ctx)}"`)
    }),
    destroy: (n, ctx) => withClient(ctx, async (c) => {
      await c.execute(`DROP SCHEMA "${schemaName(n, ctx)}" CASCADE`)
    }),
  }
}
```

- `schemaName(n, ctx)` = `` `${ctx.config.project_name}_${n}` ``.toUpperCase()。
- **probe / CREATE / DROP 的 SQL 细节**（系统目录视图名、`dmdb` 的 execute 返回结构）在实现时对照达梦文档与 `dmdb` 包 API 锁定；本设计只固定语义（存在性判断 + 建删 schema）与大小写策略（带双引号 + 大写名，保证大小写精确匹配）。
- `dmdb` 的连接 API（`createConnection` / 连接串格式 `dm://user:pass@host:port`）在实现时确认；连接复用、断连处理对齐 postgres 的「每次操作 connect → fn → end」短连接模式（资源管理频次低，无需连接池）。

## registry（`src/providers/registry.ts`）

```ts
if (ctx.config.infra.dameng) list.push(createDamengProvider())
```

## 环境变量注入（`src/frameworks/backendEnv.ts`）

```ts
if (names.dmSchema) out.BK_DM_SCHEMA = names.dmSchema
```

- 所有 worktree 共享同一连接用户、连接串恒定，**唯一随 worktree 变化的就是 schema 名**，故后端默认 `BK_*` 集只产 `BK_DM_SCHEMA`（连接 host/port/user 不注入——属共享静态信息，由项目自身配置掌握，与 postgres 的 `BK_DB_NAME` 只产库名一致）。
- 应用据此设置当前 schema（如 Spring Boot `spring.datasource.hikari.schema=${BK_DM_SCHEMA}`，或 DM JDBC 连接串里指定 schema）——这是项目自己的事，bk 不替项目决定 yml 属性路径。
- `BK_DB_NAME`（postgres 专属）与 `BK_DM_SCHEMA` 互不复用，语义各自独立。

## 占位符扩展（`src/inject/interpolate.ts`）

把达梦接入统一注入模型，新增 `{infra.dameng.*}` 命名空间，让用户在 `envs`/`command` 里按需引用：

| 占位符 | 含义 | 来源 |
|---|---|---|
| `{infra.dameng.schema}` | 已分配 schema 名 | 动态（dmSchema） |
| `{infra.dameng.host}` / `.port` / `.username` / `.password` | 静态连接信息 | `config.infra.dameng` |

实现点：

1. `InterpValues.infra` 加 `dameng?` 段（含 schema + host/port/username/password）。
2. 正则 `/^infra\.(postgres|redis|minio)\.(\w+)$/` 扩展为含 `dameng`。
3. `buildInterpValues` 拼 `dameng` 段：`(i.dameng || names.dmSchema)` 时产出，动态 `schema = names.dmSchema`、静态来自 `i.dameng`（逻辑与 postgres 段一致）。
4. 沿用「引用未分配资源 → `CONFIG_INVALID` 并指明 service/占位符」的现有报错约定（`{infra.dameng.schema}` 但未声明 dameng 即报错）。

## 展示（`src/cli/commands/list.ts`）

```ts
if (config.infra.dameng && r.resources.dameng) lines.push(`    - 达梦 schema: ${r.resources.dameng.schema}`)
```

受 `config.infra.dameng` 过滤（沿用「按当前 bk_config 过滤展示」的显示层约定，不改 state、不动 `.env`）。

## 向后兼容

- 现有配置无 `infra.dameng` → provider 不注册、占位符段不产出、`BK_DM_SCHEMA` 不生成，行为与今完全一致。
- `SetRecord.resources.dameng` 为可选字段，旧 state 文件无此键不报错。
- 新增 `dmdb` 依赖同 `pg`/`ioredis`/`minio` 一样随 `registry` 静态加载（沿用现有约定）；未声明达梦时 `registry` 不构造 dameng provider，不触发任何 dmdb 连接调用（语义层面无副作用）。

## 影响的文件（预估）

- `src/providers/dameng.ts`：**新增**（plan/probe/provision/destroy，`dmdb` 连接）。
- `src/providers/registry.ts`：条件注册 dameng。
- `src/core/types.ts`：`InfraConfig.dameng`、`ResourceNames.dmSchema`、`SetRecord.resources.dameng`。
- `src/frameworks/backendEnv.ts`：产 `BK_DM_SCHEMA`。
- `src/inject/interpolate.ts`：`InterpValues.infra.dameng`、正则含 dameng、`buildInterpValues` 拼装。
- `src/cli/commands/list.ts`：展示行。
- `package.json`：新增 `dmdb` 依赖（确认其是否自带 TS 类型，无则补 `@types/dmdb` 或局部声明）。
- `README.md`：`infra.dameng` 配置说明、`BK_DM_SCHEMA` 环境变量、`{infra.dameng.*}` 占位符、Spring Boot 设置当前 schema 示例。
- `CHANGELOG.md`：新增条目。

## 测试

- **provider 单测**（`tests/providers/dameng.test.ts`）：`plan` 命名——大写、按 N 递增（`foo` + N=1 → `FOO_1`）。纯计算，无需连接。
- **流程测试**：现有用 `fakeProvider` 的 allocate/provision 回滚/幂等/destroy 流程测试天然覆盖新 provider 类型，无需为达梦重复。
- **集成测试**（`tests/providers/dameng.integration.test.ts`）：`describe.runIf(process.env.BK_DM_HOST)` 守卫——本机常驻实例经环境变量提供连接信息时能跑（provision 建表 → probe 复测为 false → destroy 删表 → probe 复测为 true）；CI 无该变量自动跳过、不变红（与 postgres/redis/minio 的 testcontainers 路子不同——达梦镜像授权受限、不进 CI，纯本地可选验证）。
- **插值回归**（`tests/inject/interpolate.test.ts`）：`{infra.dameng.schema}` 正常解析；引用未声明达梦 → `CONFIG_INVALID`；静态字段解析。

## 非目标（YAGNI）

- **`bk init` 自动侦测达梦**：bk init 只侦测框架（django/springboot 等），不侦测 infra（postgres/redis/minio 也从不侦测，全靠用户填 `bk_config.yml`）。达梦同理。
- **按用户/表空间隔离**：已否决（见上）。
- **DM 镜像进 testcontainers/CI**：授权受限，本地可选集成测试即可。
- **建表 / seed**：bk 不管资源内容（建表是项目自己的事），只管 schema 的创建/销毁。
- **postgres ↔ dameng 自动迁移/兼容**：两者是各自独立的 infra 类型，无转换逻辑。
