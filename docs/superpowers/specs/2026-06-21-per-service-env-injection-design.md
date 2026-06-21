# 按 service 量身定制 .env 注入（前端 envs 与占位符插值）

- 日期：2026-06-21
- 状态：设计已批准，待写实现计划

## 背景与问题

`bk allocate` 当前把所有 provider（postgres/redis/minio）的 `envVars` 经 `collectEnv()` 合并成**同一个 env 块**，再由 `writeServiceEnvs()` **原样写进每个 service 目录的 `.env`**：

```
# >>> bk managed >>>
BK_DB_NAME=foo_2
BK_REDIS_DB=2
BK_MINIO_BUCKET=foo-2
# <<< bk managed <<<
```

这导致两个问题：

1. **前端被塞了一堆没用的 `BK_` 变量**——env 块全局统一、每个目录都写一份，前端目录也被注入 DB/Redis/MinIO 标识。
2. **前端拿不到它唯一需要的东西——后端地址**。端口现在只通过启动命令的 `--port` 传参（从不进 `.env`），而 `VITE_API_BASE` 这类变量必须在前端 `.env` 里才能被 Vite 读到。

本质修正：env 注入从「**全局统一块**」改为「**按 service 量身定制块**」——后端服务拿隔离标识，前端服务拿后端 URL。

范围：先满足**单后端**场景（一个前端连一个后端）。多后端留待以后。

## 设计

### 1. 新增配置字段 `envs`

每个 service 可选 `envs: Record<string, string>`（主要给前端用）。

```yaml
services:
  backend:
    type: django
    port_base: 10000
    dir: backend
  frontend:
    type: vite
    port_base: 10100
    dir: frontend
    envs:
      VITE_API_BASE: http://localhost:{backend.port}
```

- `src/core/types.ts` 的 `ServiceConfig` 增加 `envs?: Record<string, string>`。
- `src/config/load.ts` 在 map→数组时透传 `envs`（当前第 15 行未带该字段）。

### 2. 占位符插值

`envs` 的值里支持占位符 `{<服务名>.port}`，解析为该 service 的已分配端口（`port_base + N`）。

- 首批**只实现 `.port`**；语法预留扩展（以后可加 `{db}`/`{redis_db}`/`{bucket}` 等）。
- 解析目标服务名不存在、或该服务无 `port_base` → 抛 `CONFIG_INVALID`，错误信息点明是哪个占位符解析失败、在哪个 service 的 `envs` 里。
- 插值发生在 allocate 时（此时 N 已定，各服务端口已知）。

### 3. 每个 service 的最终 env = 类型默认 + envs 叠加

- **后端类**（django / fastapi / arq / celery）：framework adapter 贡献隔离标识——`BK_DB_NAME`、`BK_REDIS_DB`（或 `isolation: key_prefix` 时的 `BK_REDIS_PREFIX`）、`BK_MINIO_BUCKET`。维持现有取值逻辑，仅迁移产出位置（见第 6 节）。
- **vite**：adapter **不贡献任何 `BK_` 变量**。
- 用户写的 `envs`（插值后）叠加在类型默认之上；**同名键 `envs` 覆盖类型默认**。
- **vite 没写 `envs` → bk 对该服务一行不写**（不做任何兜底默认）。若其目录下也没有别的 service 贡献变量，则该目录不写 `.env` 块。

### 4. `bk init` 探测前端

对每个 vite service，扫其 `dir` 下的 `.env`、`.env.example`、`.env.local`、`.env.development`，匹配形如 `VITE_*=http://...localhost...` 的行：

- **命中**：把变量名与 URL 格式原样搬进 `envs`，仅将 URL 中的端口替换成 `{backend.port}`（`backend` = 探测到的那个唯一有端口的后端服务名）。命中多行就写多条。
- **未命中**：写一段**注释掉的 `envs` stub**（与现有"注释掉的 arq/celery worker stub"一脉相承），提示旋钮存在但不激活任何东西（符合"没写就不管"）：

  ```yaml
    frontend:
      type: vite
      port_base: 10100
      dir: frontend
      # envs:                                        # 取消注释并按需填写
      #   VITE_API_BASE: http://localhost:{backend.port}
  ```

- `vite.config.ts` 首批不解析，留待以后。

### 5. 写入与合并

`writeServiceEnvs` 改为：**按 service 计算各自 env → 按目录（`dir`，缺省为 worktree 根）分组合并 → 每个目录写一份 `.env`**。

- `backend/`（backend + worker 同目录）→ 合并后是那几个 `BK_*`，两服务取值相同、幂等。
- `frontend/` → 只有 `VITE_API_BASE=http://localhost:10001`。
- 合并时若同目录不同 service 对同一键给出冲突值，以确定性顺序合并（后者覆盖前者）；正常场景不会冲突。

下列机制完全不变：

- 标记块 `# >>> bk managed >>>` / `# <<< bk managed <<<`，只动块内、绝不碰块外 secrets。
- 按 `dir` 去重（同目录多 service 共用一份）。
- `ensureGitignore` 处理 `.env`。
- `deallocate` 时 `removeServiceEnvs` 按目录剥除标记块。

### 6. provider.envVars 的归宿（干净重构）

env 来源收口到 framework adapter：

- 移除 provider 接口里直接写盘的 `envVars`（postgres/redis/minio 不再产环境变量字符串）。
- provider 回归纯"资源生命周期 + 资源名"职责，继续通过 `plan()` 产出 `ResourceNames`（database / redisDb / redisPrefix / bucket）。
- 后端类 framework adapter 负责把 `ResourceNames` 转成 `BK_*` 环境变量。
- `collectEnv()` 被 per-service 计算取代。

`FrameworkAdapter` 新增 env 贡献方法（签名示意，最终以实现计划为准）：

```ts
envVars(svc: ServiceConfig, names: ResourceNames, ctx: Ctx): Record<string, string>
```

- django / fastapi / arq / celery → 返回 `BK_*`（取自 `names`）。
- vite → 返回 `{}`（其变量全来自 `envs`）。

### 7. 边界与报错

- `envs` 占位符引用的服务名不存在 / 无 `port_base` → `CONFIG_INVALID`，指明 service 与占位符。
- vite 服务的 `envs` 引用了某后端端口，但项目里没有任何带端口的后端 → 同上报错，提示显式配置或检查服务名。
- vite 无 `envs` → 不报错、不写入（静默跳过）。

## 影响的文件（预估）

- `src/core/types.ts`：`ServiceConfig.envs?`
- `src/config/load.ts`：透传 `envs`
- `src/frameworks/types.ts`：`FrameworkAdapter.envVars(...)`
- `src/frameworks/{django,fastapi,arq,celery}.ts`：实现 `envVars` 产 `BK_*`
- `src/frameworks/vite.ts`：`envVars` 返回 `{}`
- `src/providers/{postgres,redis,minio,port}.ts`、`src/providers/types.ts`：移除 `envVars`
- `src/core/allocator.ts`：`collectEnv` 改为 per-service 计算 + 占位符插值（或新建插值模块）
- `src/cli/commands/allocate.ts`：`writeServiceEnvs` 按 service 分组合并
- `src/cli/commands/init.ts`：前端 `.env*` 探测 + 写 `envs` / 注释 stub
- `README.md`：更新 `.env` 注入章节、`envs` 字段说明、占位符语法

## 测试

- 占位符插值：正常、未知服务名、无 port_base 三种路径。
- per-service 合并：前端只得 `VITE_API_BASE`、不含 `BK_`；后端+worker 同目录合并幂等。
- vite 无 `envs` → 该目录不写块。
- `bk init` 探测：命中（含多行、含路径前缀/不同变量名）、未命中写注释 stub。
- 回归：现有 `tests/inject/env.test.ts`、`tests/cli/allocate.flow.test.ts` 适配新模型。

## 非目标（YAGNI）

- 多后端选择（多个带端口后端时的目标消歧）。
- `{db}` / `{redis_db}` / `{bucket}` 等非端口占位符（语法预留，暂不实现）。
- 解析 `vite.config.ts`。
