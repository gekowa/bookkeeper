# GitHub CI + npm Publish 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 配置 GitHub Actions CI（PR 自动测试）和 npm 自动发版（tag 触发）

**Architecture:** 两个独立 workflow 文件——`ci.yml` 负责 PR 测试，`publish.yml` 负责 tag 触发的 npm 发版。共享 Node 20 + npm cache 配置。

**Tech Stack:** GitHub Actions, actions/checkout@v4, actions/setup-node@v4, npm, vitest, tsup

## Global Constraints

- Node 版本：20（和 `engines` 字段一致）
- 包名：`bookkeeper-cli`
- npm 访问级别：public
- 集成测试不在 CI 跑（`describe.runIf(hasDocker())` 守卫自动跳过）
- tag 格式：`v*`（如 `v0.0.15`）

---

### Task 1: 创建 ci.yml（PR 测试 workflow）

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: PR 提交时自动运行 typecheck + test 的 CI check

- [ ] **Step 1: 创建 .github/workflows 目录**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: 写入 ci.yml**

```yaml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test -- --exclude '**/*.integration.test.ts'
```

- [ ] **Step 3: 验证 YAML 语法**

```bash
npx yaml-lint .github/workflows/ci.yml 2>/dev/null || python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"
```

Expected: 无报错

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add PR test workflow (typecheck + test)"
```

---

### Task 2: 创建 publish.yml（npm 发版 workflow）

**Files:**
- Create: `.github/workflows/publish.yml`

**Interfaces:**
- Produces: push `v*` tag 时自动 typecheck + test + build + npm publish

- [ ] **Step 1: 写入 publish.yml**

```yaml
name: Publish to npm

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test -- --exclude '**/*.integration.test.ts'
      - run: npm run build
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 2: 验证 YAML 语法**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/publish.yml'))"
```

Expected: 无报错

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: add npm publish workflow (tag-triggered)"
```

---

### Task 3: 更新 package.json

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: 包名改为 `bookkeeper-cli`，添加 `repository` 字段

- [ ] **Step 1: 修改 package.json**

将 `"name": "bookkeeper"` 改为 `"name": "bookkeeper-cli"`，在 `name` 之后添加：

```json
"repository": {
  "type": "git",
  "url": "https://github.com/gekowa/bookkeeper.git"
},
```

完整 diff：
```diff
- "name": "bookkeeper",
+ "name": "bookkeeper-cli",
+ "repository": {
+   "type": "git",
+   "url": "https://github.com/gekowa/bookkeeper.git"
+ },
  "version": "0.0.14",
```

- [ ] **Step 2: 验证 package.json 有效**

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: 验证 npm 能解析包名**

```bash
npm pkg get name
```

Expected: `"bookkeeper-cli"`

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: rename package to bookkeeper-cli, add repository field"
```

---

### Task 4: 端到端验证

- [ ] **Step 1: 本地验证 build 正常**

```bash
npm run build
ls -la dist/cli/index.js
```

Expected: 文件存在，有 shebang

- [ ] **Step 2: 本地验证 test 正常**

```bash
npm run test
```

Expected: 全部通过（集成测试因无 Docker 自动跳过）

- [ ] **Step 3: 本地验证 typecheck 正常**

```bash
npm run typecheck
```

Expected: 无报错

- [ ] **Step 4: 确认 workflow 文件在 git 中**

```bash
git status
```

Expected: 工作区干净，所有变更已提交
