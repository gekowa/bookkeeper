# Spring Boot 多模块微服务识别（bk init）设计

- 日期：2026-07-02
- 状态：设计已确认，实现中
- 关联：升级 `2026-07-01-unified-injection-model-design.md` 落地的 springboot 适配器；驱动场景 = PanguMall（`backend/<svc>/{<svc>.server, <svc>.client, <svc>-starter}` 多模块微服务栈）
- 涉及代码：`src/frameworks/springboot.ts`、`src/cli/commands/init.ts`、`tests/frameworks/detect.test.ts`、`tests/cli/init.test.ts`

## 背景

`bk init` 现有 springboot 侦测只看「单目录 pom 含 `/spring-boot/`」。PanguMall 式微服务栈无法识别：

- `backend/<svc>/pom.xml` 是 Maven **聚合器**（`<modules>`），不含 `spring-boot`；`detect(backend/pangumall-auth)` → false。
- 可运行入口在 **子模块 `<svc>/<svc>.server/`**（`@SpringBootApplication` main + `spring-boot-maven-plugin` + `Dockerfile ADD <svc>.server/target/*.jar`）。
- `pangumall-common` / `*-spring-boot-starter` / `pangumall-rule` 是**库**（无 plugin、无 main），须跳过。
- 现有 PanguMall `bk_config.yml` 错把整个 `backend` 当**一个** springboot 服务。

事实核实（推翻"starter 是起点"的初始假设）：可运行的是 `.server`，`-starter` 是 auto-config 库（`@ComponentScan`+`@ConditionalOnWebApplication`，无 main）。铁证 = `auth/Dockerfile: ADD pangumall-auth.server/target/*.jar`。

端口：**无固定端口**。各微服务启动时向 Nacos 上报自己的端口，Feign 经服务名发现。故 bk 的 `port_base + N` 模型适用——注入 `-DSERVER_PORT={port}`，服务自行注册。

## 设计

### 1. 识别信号 = `spring-boot-maven-plugin`

一个 Maven 模块「可被 `spring-boot:run` 运行」的可靠信号是其 pom 声明了 `spring-boot-maven-plugin`。据此：

```ts
// 对一个「服务目录」s，找它的可运行模块：
function findRunnableModule(s: string): string | null {
  if (hasSpringBootPlugin(join(s, 'pom.xml'))) return s                 // 单模块（gateway）
  for (const child of childDirs(s))
    if (hasSpringBootPlugin(join(child, 'pom.xml'))) return child       // 多模块（.server）
  return null                                                            // 库，跳过
}
```

`hasSpringBootPlugin(pom)` = 文件存在且内容含 `spring-boot-maven-plugin`。

### 2. `discoverSpringBootServices(containerDir)`（新导出，`src/frameworks/springboot.ts`）

给一个 Maven 容器目录（如 `backend`），遍历其一级子目录，逐个 `findRunnableModule`，产出：

```ts
{ name: string; moduleRelPath: string }[]   // name=服务目录名；moduleRelPath=可运行模块相对 container 的路径
```

PanguMall `backend/` → `[{auth, pangumall-auth/pangumall-auth.server}, …, {gateway, pangumall-gateway}]`（7 个多模块 + gateway 单模块），过滤掉 common/event-spring-boot-starter/rule。

`detect(dir)` 同步增强：dir 自身有 plugin，或 dir 是含可运行子模块的容器 → true（让 `detectType` 在容器层也能识别）。

### 3. `buildConfigDraft` 接入（`src/cli/commands/init.ts`）

现有流程对每个一级子目录 `detectType`。新增：当某子目录 `detectType` 为 null **但**是 Maven 容器（`pom.xml` 含 `<modules>`）时，调 `discoverSpringBootServices` 展开：

- 每个发现的服务 → 一条 `springboot` 草稿项，`dir = <容器目录>`（Maven 根，使 `-s`/`-pl` 相对路径统一）。
- `command`（多模块形）：
  ```
  mvn [-s <settings>] spring-boot:run -pl <moduleRelPath> -Dmaven.test.skip=true -Dspring-boot.run.jvmArguments=-DSERVER_PORT={port}
  ```
  `<settings>` = 若容器下有 `maven-settings*.xml` 则带 `-s <relpath>`（PanguMall 有 `maven-settings-bytz.xml`，私有镜像需要），否则省略。
- `port_base`：沿用现有 `10000 起、每服务 +100` 顺序分配（端口可调、Nacos 注册，具体值不关键，用户可调）。
- profile / Nacos 密钥等强项目相关项：草稿里以注释 `# TODO` 提示用户补（bk 不臆测）。

### 4. `post_allocate` 安装钩子

内部库（`pangumall-common` + 各 `*.client` + `-starter`）须先进 m2，`spring-boot:run -pl <server>` 才解析得到。挂在**首个检测到的 springboot 服务**上（只跑一次，幂等）：

```
mvn [-s <settings>] install -Dmaven.test.skip=true -Dcheckstyle.skip=true -Dspotbugs.skip=true -Denforcer.skip=true
```

（dev-guide L2 刷 m2 的等价；skip-gates 与启动命令一致。）

## 不做（YAGNI）

- **多 worktree 并行隔离整套微服务栈**（虽因 Nacos 端口可调而理论可行）：本次不做，仅单栈编排。
- **解析 `application.yml`/Nacos 取原生端口**：端口可调 + Nacos 注册，bk 顺序分配即可。
- **gateway 多实例（8197/8198/8199 三 profile）**：bk 一个服务 = 一个进程，gateway 草稿只产一条；多实例由用户复制条目改 profile。
- **硬编码 PanguMall 专有项**（profile/Nacos 密码/特定 settings 名）：仅 `maven-settings*.xml` 做通用探测，其余 TODO。

## 测试

- `tests/frameworks/detect.test.ts`：新增多模块 fixture（聚合器 pom + 子模块 `<svc>.server` 含 plugin + `-starter` 子模块不含）→ `detect` true；`discoverSpringBootServices` 返回 `.server` 模块、过滤无 plugin 的库目录。
- `tests/cli/init.test.ts`：构造一个微服务容器临时目录（聚合器 + 2 个服务：一个多模块、一个单模块 + 一个库）→ 草稿含 2 条 springboot，`dir` = 容器、`command` 含 `-pl`、port_base 递增；首条带 `post_allocate` install 钩子；`maven-settings.xml` 存在时命令含 `-s`。
