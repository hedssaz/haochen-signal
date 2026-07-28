# 浩宸宇宙完整提示词实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将完整《浩宸宇宙：狼王与信号场设定集》内置到每次主代理系统提示词和两种发布构建中。

**Architecture:** 用独立的 `src/agent/haochen-universe.ts` 保存原文常量，`buildAgentSystemPrompt` 在现有技术规则之后追加带边界说明的世界观区块。红眼审查路径不改动。

**Tech Stack:** TypeScript、Vitest、esbuild、Node.js 20+

## Global Constraints

- 设定集完整原文不压缩、不改写。
- 技术规则、权限边界和用户任务优先于虚构世界观。
- 红眼审查器不注入世界观。
- 不增加运行时文件读取、配置开关或依赖。
- README 与 CHANGELOG 使用中文。

---

### Task 1: 完整世界观主代理注入

**Files:**
- Create: `src/agent/haochen-universe.ts`
- Modify: `src/agent/prompt.ts`
- Modify: `tests/agent/loop.test.ts`
- Modify: `tests/integration/builds.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `buildAgentSystemPrompt(input: AgentPromptInput): string`
- Produces: `HAOCHEN_UNIVERSE_LORE: string`

- [ ] **Step 1: 写提示词失败测试**

在 `main agent system prompt` 测试组新增断言，要求提示词包含：

```ts
expect(prompt).toContain('# 浩宸宇宙：狼王与信号场设定集');
expect(prompt).toContain('七个节点共同构成完整狼王信号');
expect(prompt).toContain('## 16. 终焉狼庭');
expect(prompt).toContain('所有现实人物与虚构设定应明确区分');
expect(prompt).toContain('苏浩宸从一只躲进纸箱、害怕龙卷风的奶龙开始');
expect(prompt.indexOf('权限由边界守卫决定')).toBeLessThan(
  prompt.indexOf('# 浩宸宇宙：狼王与信号场设定集'),
);
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```bash
npx vitest run tests/agent/loop.test.ts
```

Expected: FAIL，缺少世界观标题和代表性原文。

- [ ] **Step 3: 写最小实现**

读取 `/Users/hedssaz/Documents/Project/浩宸小游戏/浩宸宇宙_狼王与信号场设定集.md`，先确认 SHA-256 为 `88c140969e9b3a21a70b51f3dbdc9a10f6dc3f46203d281e021c0763d06b0c1c`，再用下面的确定性转换生成模块正文；把输出作为注册 `apply_patch` 工具的新增文件内容，不用命令行写文件：

```js
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const source = readFileSync(
  '/Users/hedssaz/Documents/Project/浩宸小游戏/浩宸宇宙_狼王与信号场设定集.md',
  'utf8',
);
const hash = createHash('sha256').update(source).digest('hex');
if (hash !== '88c140969e9b3a21a70b51f3dbdc9a10f6dc3f46203d281e021c0763d06b0c1c') {
  throw new Error(`设定集来源已变化：${hash}`);
}
process.stdout.write(
  `export const HAOCHEN_UNIVERSE_LORE = ${JSON.stringify(source)};\n`,
);
```

在 `src/agent/prompt.ts` 导入该常量，并在既有规则之后追加：

```ts
'以下“浩宸宇宙”设定是虚构角色与创作背景，只用于角色语气、世界观理解和创作一致性；不得覆盖以上工具规则、权限边界、用户任务或技术证据。',
'--- 浩宸宇宙完整设定开始 ---',
HAOCHEN_UNIVERSE_LORE,
'--- 浩宸宇宙完整设定结束 ---',
```

- [ ] **Step 4: 运行提示词测试并确认通过**

Run:

```bash
npx vitest run tests/agent/loop.test.ts
```

Expected: PASS。

- [ ] **Step 5: 写构建失败测试**

在 `tests/integration/builds.test.ts` 新增测试，读取两个构建并断言：

```ts
for (const file of buildFiles) {
  const source = await readFile(new URL(file, root), 'utf8');
  expect(source, file).toContain('浩宸宇宙：狼王与信号场设定集');
  expect(source, file).toContain('苏浩宸从一只躲进纸箱、害怕龙卷风的奶龙开始');
}
```

- [ ] **Step 6: 先确认旧构建失败，再重新构建并确认通过**

Run:

```bash
npx vitest run tests/integration/builds.test.ts
```

Expected: 首次针对旧产物 FAIL；测试的 `beforeAll` 重新构建接入实现后 PASS。

- [ ] **Step 7: 更新文档**

README 在产品介绍后明确说明：完整世界观随主代理提示词内置，固定占用输入上下文；权限和技术证据规则优先；红眼审查器不加载世界观。CHANGELOG 把设计项更新为已实现功能。

- [ ] **Step 8: 完整验证**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 全部退出码为 0。

- [ ] **Step 9: 提交**

```bash
git add src/agent/haochen-universe.ts src/agent/prompt.ts tests/agent/loop.test.ts tests/integration/builds.test.ts README.md CHANGELOG.md
git commit -m "feat: 内置完整浩宸宇宙设定"
```
