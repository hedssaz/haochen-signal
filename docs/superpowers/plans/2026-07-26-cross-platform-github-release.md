# 浩宸信号跨平台与 GitHub 公开发布实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将浩宸信号以醒目的纯恶搞声明公开发布到 `hedssaz/haochen-signal`，并以代码、文档和三平台 CI 证明 macOS、Linux、Windows 的基础兼容。

**Architecture:** 把用户目录和平台凭据选择提取为可单测的纯函数，入口只负责组装；首次配置仅在注入了凭据保存器时询问是否保存。README 负责如实声明平台差异，GitHub Actions 用同一套 npm 命令在三种操作系统上验证。

**Tech Stack:** TypeScript 7、Node.js 20、React/Ink、Vitest、GitHub Actions、GitHub CLI。

## Global Constraints

- GitHub 仓库必须是公开的 `hedssaz/haochen-signal`，默认分支为 `main`。
- README 首屏必须同时显示中文和英文“纯恶搞、不要用于真实项目”警告。
- 本次不发布 npm 包，不创建 GitHub Release。
- macOS 保留可选 Keychain；Linux/Windows 只用 `HAOCHEN_API_KEY` 或本次临时输入，不能明文持久化 API Key。
- CI 使用 Node.js 20，并在 `ubuntu-latest`、`windows-latest`、`macos-latest` 全部运行测试、类型检查、构建和版本启动检查。
- README、CHANGELOG 与提交信息使用中文；不引入与项目无关的产品或模型品牌。
- 每项代码变更遵循 TDD：先看到针对缺失行为的失败，再写最小实现。

---

## 文件结构

- 新建 `src/cli/platform.ts`：集中决定可靠用户目录和当前平台是否提供系统凭据保存器。
- 修改 `src/cli/index.tsx`：调用平台函数，不再直接使用 `HOME ?? cwd`，不再无条件提供 Keychain 保存器。
- 修改 `src/cli/first-run.ts`：只有存在 `saveKey` 时才询问是否保存。
- 新建 `tests/cli/platform.test.ts`：验证 Windows/Linux/macOS 平台选择和用户目录回退。
- 修改 `tests/cli/first-run.test.ts`：验证无保存器时不询问、有保存器时仍能保存。
- 修改 `tests/config/load.test.ts`：消除只在 POSIX 上成立的绝对路径断言。
- 新建 `.github/workflows/ci.yml`：三系统 Node.js 20 验证矩阵。
- 新建 `tests/integration/cross-platform-release.test.ts`：验证工作流矩阵、执行步骤和 README 首屏声明。
- 修改 `README.md`：纯恶搞声明、支持表和三平台安装配置。
- 修改 `CHANGELOG.md`：记录跨平台适配、CI 和公开发布说明。

---

### Task 1: 用户目录与平台凭据选择

**Files:**
- Create: `src/cli/platform.ts`
- Create: `tests/cli/platform.test.ts`
- Modify: `src/cli/index.tsx`
- Modify: `src/cli/first-run.ts`
- Modify: `tests/cli/first-run.test.ts`
- Modify: `tests/config/load.test.ts`

**Interfaces:**
- Consumes: `saveMacOsKeychain(key: string): Promise<void>`、`getAppPaths(env, home)`。
- Produces: `resolveUserHome(env: NodeJS.ProcessEnv, fallback: string): string`。
- Produces: `credentialSaverForPlatform(platform: NodeJS.Platform, saveKey: (key: string) => Promise<void>): ((key: string) => Promise<void>) | undefined`。
- Changes: `runFirstRunWithCredentials` only reads the Keychain choice when `output.saveKey !== undefined`.

- [ ] **Step 1: Write failing platform tests**

```ts
import {describe, expect, it, vi} from 'vitest';
import {
  credentialSaverForPlatform,
  resolveUserHome,
} from '../../src/cli/platform.js';

describe('CLI platform integration', () => {
  it.each([{}, {HOME: ''}, {HOME: '   '}])(
    'falls back to os.homedir input when HOME is unavailable',
    env => {
      expect(resolveUserHome(env, '/users/haochen')).toBe('/users/haochen');
    },
  );

  it('uses a non-empty HOME when supplied', () => {
    expect(resolveUserHome({HOME: '/custom/home'}, '/fallback')).toBe('/custom/home');
  });

  it.each(['linux', 'win32'] as const)(
    'does not expose a Keychain saver on %s',
    platform => {
      expect(credentialSaverForPlatform(platform, vi.fn())).toBeUndefined();
    },
  );

  it('exposes the injected Keychain saver on macOS', async () => {
    const save = vi.fn(async () => undefined);
    const selected = credentialSaverForPlatform('darwin', save);
    await selected?.('secret');
    expect(save).toHaveBeenCalledWith('secret');
  });
});
```

- [ ] **Step 2: Run the new platform tests and verify RED**

Run: `npm test -- tests/cli/platform.test.ts`

Expected: FAIL because `src/cli/platform.ts` does not exist.

- [ ] **Step 3: Implement the platform helpers**

```ts
export function resolveUserHome(
  env: NodeJS.ProcessEnv,
  fallback: string,
): string {
  const home = env.HOME?.trim();
  return home || fallback;
}

export function credentialSaverForPlatform(
  platform: NodeJS.Platform,
  saveKey: (key: string) => Promise<void>,
): ((key: string) => Promise<void>) | undefined {
  return platform === 'darwin' ? saveKey : undefined;
}
```

- [ ] **Step 4: Write failing first-run tests**

Add a test where the input script contains only endpoint、model、key and `saveKey` is absent; assert that no prompt contains `系统钥匙串`. Add a macOS-capability test with `saveKey` present and answer `y`; assert `keySaved === true` and `saveKey('temp-key')`.

- [ ] **Step 5: Run the first-run tests and verify RED**

Run: `npm test -- tests/cli/first-run.test.ts`

Expected: FAIL because the no-saver path still asks `将 API Key 保存到系统钥匙串？`.

- [ ] **Step 6: Make the Keychain prompt conditional**

In `runFirstRunWithCredentials`, replace the unconditional choice with:

```ts
if (output.saveKey !== undefined) {
  const choice = (
    await input.read('将 API Key 保存到系统钥匙串？[y/N]：')
  ).trim().toLowerCase();
  if (choice === 'y' || choice === 'yes') {
    await output.saveKey(apiKey);
    output.write('API Key 已保存到系统钥匙串。\n');
    return {config, apiKey, keySaved: true};
  }
}

output.write('API Key 仅在本次进程中使用，不会写入配置文件。\n');
return {config, apiKey, keySaved: false};
```

- [ ] **Step 7: Wire helpers into the CLI entry**

Import `homedir` beside `tmpdir`, import both platform helpers, then use:

```ts
const paths = getAppPaths(
  process.env,
  resolveUserHome(process.env, homedir()),
);
```

For first-run output use:

```ts
const created = await runFirstRunWithCredentials(input, {
  write: text => process.stdout.write(text),
  saveKey: credentialSaverForPlatform(
    process.platform,
    saveMacOsKeychain,
  ),
});
```

- [ ] **Step 8: Make configuration path tests platform-neutral**

Use `resolve('cfg')`, `resolve('data')`, `resolve('state')` and `join(...)` in `tests/config/load.test.ts` instead of POSIX-only `'/cfg'` expectations. Preserve the invalid relative-path cases.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run:

```bash
npm test -- tests/cli/platform.test.ts tests/cli/first-run.test.ts tests/config/load.test.ts tests/config/credentials.test.ts
npm run typecheck
```

Expected: all selected tests pass and TypeScript exits 0.

- [ ] **Step 10: Commit**

```bash
git add src/cli/platform.ts src/cli/index.tsx src/cli/first-run.ts tests/cli/platform.test.ts tests/cli/first-run.test.ts tests/config/load.test.ts
git commit -m "feat: 补齐三平台启动与凭据流程"
```

---

### Task 2: 恶搞声明、三平台文档与 CI

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `tests/integration/cross-platform-release.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: npm scripts `test`、`typecheck`、`build` and built entry `dist/cli.mjs`.
- Produces: GitHub Actions workflow `跨平台验证`.
- Produces: README first-screen disclaimer and platform-specific copyable commands.

- [ ] **Step 1: Write failing release-contract tests**

Create a Vitest test that reads `README.md` and `.github/workflows/ci.yml`, then asserts:

```ts
expect(readme.slice(0, 1_500)).toContain('纯恶搞');
expect(readme.slice(0, 1_500)).toContain('DO NOT USE');
expect(readme).toContain('macOS');
expect(readme).toContain('Linux');
expect(readme).toContain('Windows PowerShell');
expect(workflow).toContain('ubuntu-latest');
expect(workflow).toContain('windows-latest');
expect(workflow).toContain('macos-latest');
expect(workflow).toContain('node-version: 20');
for (const command of [
  'npm ci',
  'npm test',
  'npm run typecheck',
  'npm run build',
  'node dist/cli.mjs --version',
]) {
  expect(workflow).toContain(command);
}
```

- [ ] **Step 2: Run the release-contract test and verify RED**

Run: `npm test -- tests/integration/cross-platform-release.test.ts`

Expected: FAIL because `.github/workflows/ci.yml` is absent and README has no first-screen warning.

- [ ] **Step 3: Add the GitHub Actions matrix**

Create `.github/workflows/ci.yml`:

```yaml
name: 跨平台验证

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  verify:
    name: Node 20 · ${{ matrix.os }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run typecheck
      - run: npm run build
      - run: node dist/cli.mjs --version
```

- [ ] **Step 4: Rewrite the README opening and installation sections**

Place this warning before the title:

```md
> [!CAUTION]
> **纯恶搞项目，请勿用于真实开发。**
> 本仓库只用于玩梗和实验，不保证正确性、安全性、数据完整性或兼容性。不要让它接触生产项目、重要代码、真实凭据或任何无法恢复的数据。
>
> **PARODY PROJECT — DO NOT USE FOR REAL WORK.**
> This repository is a joke and experiment. Do not use it with production projects, important source code, real credentials, or irreplaceable data.
```

Add a platform table and copyable sections:

- macOS/Linux POSIX Shell: `npm install --global .` and `export HAOCHEN_API_KEY='...'`.
- Windows PowerShell: `npm install --global .` and `$env:HAOCHEN_API_KEY='...'`.
- State that macOS alone offers Keychain; Linux/Windows use environment or temporary hidden input.
- State that source installation is intentional because the package is not published to npm.

- [ ] **Step 5: Update the Chinese changelog**

Under `[未发布]` record:

- README 首屏纯恶搞警告；
- macOS/Linux/Windows 安装说明；
- reliable home resolution and platform-specific credential prompt；
- 三平台 GitHub Actions matrix。

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npm test -- tests/integration/cross-platform-release.test.ts
npm run typecheck
npm run build
node dist/cli.mjs --version
```

Expected: tests pass, build exits 0, version output is `0.1.0`.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml tests/integration/cross-platform-release.test.ts README.md CHANGELOG.md
git commit -m "docs: 标注恶搞用途并增加三平台验证"
```

---

### Task 3: 本地发布前验证

**Files:**
- Verify all tracked project files.

**Interfaces:**
- Consumes: completed Tasks 1–2.
- Produces: a clean, fully verified `main` candidate ready to publish.

- [ ] **Step 1: Run the complete verification suite**

Run:

```bash
npm ci
npm test
npm run typecheck
npm run build
node dist/cli.mjs --version
npm pack --dry-run
```

Expected:

- all Vitest files pass with zero failures;
- TypeScript and build exit 0;
- CLI prints `0.1.0`;
- npm pack lists only `CHANGELOG.md`、`README.md`、`dist/cli.mjs`、`dist/haochen-onefile.mjs`、`package.json`.

- [ ] **Step 2: Inspect repository hygiene**

Run:

```bash
git diff --check
git status --short
git log -3 --oneline
```

Expected: no whitespace errors; no uncommitted implementation files; latest commits are the platform and documentation commits.

---

### Task 4: 创建公开仓库、推送并等候三平台 CI

**Files:**
- External state: GitHub repository `hedssaz/haochen-signal`.
- Local Git configuration: remote `origin`.

**Interfaces:**
- Consumes: GitHub CLI authenticated as `hedssaz`, clean verified `main`.
- Produces: public GitHub repository URL and passing three-platform Actions run.

- [ ] **Step 1: Confirm no repository already occupies the target name**

Run:

```bash
gh repo view hedssaz/haochen-signal --json nameWithOwner,url,visibility
```

Expected: repository-not-found. If it exists, inspect it before any push and stop if its history is unrelated.

- [ ] **Step 2: Create the public repository and push**

Run:

```bash
gh repo create hedssaz/haochen-signal \
  --public \
  --source=. \
  --remote=origin \
  --push \
  --description "纯恶搞的苏浩宸世界观 AI 编程 CLI，请勿用于真实项目"
```

Expected: repository URL is `https://github.com/hedssaz/haochen-signal`, `main` tracks `origin/main`.

- [ ] **Step 3: Wait for the workflow run**

Run:

```bash
gh run list --repo hedssaz/haochen-signal --workflow ci.yml --limit 1
gh run watch --repo hedssaz/haochen-signal --exit-status
```

Expected: Ubuntu、Windows、macOS matrix jobs all finish successfully.

- [ ] **Step 4: If CI fails, diagnose only the failing platform**

Run:

```bash
gh run view --repo hedssaz/haochen-signal --log-failed
```

Create a regression test for the observed platform-specific failure, verify RED locally where possible, implement the minimal fix, run the complete local suite, update `CHANGELOG.md`, commit in Chinese, push `main`, and repeat Step 3.

- [ ] **Step 5: Verify public repository state**

Run:

```bash
gh repo view hedssaz/haochen-signal \
  --json nameWithOwner,url,visibility,defaultBranchRef,description
git status --short
git branch -vv
git remote -v
```

Expected:

- visibility is `PUBLIC`;
- default branch is `main`;
- description includes `纯恶搞` and `请勿用于真实项目`;
- local `main` tracks `origin/main`;
- working tree is clean.
