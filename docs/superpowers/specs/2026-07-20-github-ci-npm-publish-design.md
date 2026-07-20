# GitHub CI + npm Publish 设计

**日期**：2026-07-20
**状态**：已确认

## 目标

1. PR 提交时自动运行 typecheck + 单元测试，不通过则 fail
2. 推送 `v*` tag 时自动发布新版本到 npm（包名 `bookeeper-cli`）

## 决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| CI 结构 | 两个独立 workflow | 职责清晰，不耦合 |
| 发版触发 | git tag `v*` | 安全，发版完全由维护者控制 |
| Node 版本 | 仅 20 | 和 `engines` 一致，够用 |
| 集成测试 | 不在 CI 跑 | 需要 Docker，本地跑即可；CI 用 `--exclude '**/*.integration.test.ts'` 显式排除（`hasDocker()` 在 ubuntu-latest 上返回 true，`describe.runIf` 守卫不会自动跳过） |
| npm 包名 | `bookeeper-cli` | 用户指定 |
| npm 访问级别 | public | 公开 CLI 工具 |

## 设计

### Workflow 1: ci.yml（PR 测试）

**文件**：`.github/workflows/ci.yml`

**触发条件**：
- `pull_request` 目标分支为 `main`

**步骤**：
1. `actions/checkout@v4`
2. `actions/setup-node@v4` — node 20，启用 npm cache
3. `npm ci`
4. `npm run typecheck`
5. `npm run test -- --exclude '**/*.integration.test.ts'`

**注意**：
- `npm ci` 保证 lockfile 一致性
- typecheck 在 test 之前，类型错误时快速失败
- 集成测试用 `--exclude '**/*.integration.test.ts'` 在 CI 显式排除：`hasDocker()` 在 ubuntu-latest 上返回 true（runner 自带 Docker），`describe.runIf(hasDocker())` 守卫不会自动跳过；集成测试在本地 Docker 回路里照常跑
- PR 合并需要 branch protection 要求 status check 通过（需手动在 GitHub Settings 开启）

### Workflow 2: publish.yml（npm 发版）

**文件**：`.github/workflows/publish.yml`

**触发条件**：
- push tag 匹配 `v*`（如 `v0.0.15`）

**步骤**：
1. `actions/checkout@v4`
2. `actions/setup-node@v4` — node 20，registry 设为 `https://registry.npmjs.org`
3. `npm ci`
4. `npm run typecheck`
5. `npm run test -- --exclude '**/*.integration.test.ts'`
6. `npm run build`（tsup → dist/）
7. `npm publish --access public`
   - `setup-node` 配置 `registry-url` 后会自动写 `.npmrc`，引用环境变量 `NODE_AUTH_TOKEN`
   - workflow 中把 GitHub Secret 映射过去：`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`
   - 两个名字各管一层：`NPM_TOKEN` 是 GitHub Secrets 里的名字，`NODE_AUTH_TOKEN` 是 setup-node 约定的变量名

**发版流程**：
```bash
# 1. 修改 package.json 的 version 字段
# 2. 更新 CHANGELOG.md
# 3. git commit & push
# 4. git tag v0.0.15 && git push origin v0.0.15
# 5. CI 自动 typecheck → test → build → npm publish
```

**前置条件**：
- 在 GitHub repo Settings → Secrets → Actions 中配置 `NPM_TOKEN`
- npm token 类型选 Automation（跳过 2FA，CI 专用）

### package.json 变更

```diff
- "name": "bookkeeper",
+ "name": "bookeeper-cli",
+ "repository": {
+   "type": "git",
+   "url": "https://github.com/gekowa/bookkeeper.git"
+ },
```

其他字段不变。`"files": ["dist"]` 已正确限制发布内容。

## 不做的事

- 不引入 changesets / semantic-release 等工具（单包项目不需要）
- 不在 CI 跑集成测试（本地 Docker 环境跑）
- 不做 Node 版本矩阵（只测 20）
- 不做自动 version bump（手动改 package.json 更可控）
