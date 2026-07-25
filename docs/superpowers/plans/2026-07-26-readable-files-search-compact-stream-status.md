# 浩宸信号文件续读、搜索、压缩与流状态实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复超长单行文件和联网搜索不可用问题，让 `/compact` 正确锁定与中止，并按推理/回答流增量分别显示内容、阶段和用户定义的 token 数量。

**Architecture:** 模型适配层把 `reasoning_content` 与 `content` 转成不同事件，代理循环保持两类内容分离并在工具轮次回传推理字段，Ink 界面以唯一前台操作和实时缓冲渲染。文件工具保留 2 MiB 总上限、增加所选行内容内的 Unicode 字符分页；搜索参数在模型 Schema、运行校验和确定性边界中统一。

**Tech Stack:** TypeScript、Node.js 20、React、Ink 6、Zod、Vitest、OpenAI-compatible SSE、GitHub Actions。

## Global Constraints

- 不移除 2 MiB 文件总上限，单次 `read_file` 最多返回 65,536 个 Unicode 码点。
- 每个非空 `reasoning_delta` 或 `text_delta` 固定计为界面上的 1 token；`finish.usage` 不参与计数或状态切换。
- 首个 `text_delta` 到达时立即从“思考中”切换为“思考完成 · 正在回答”。
- `/compact` 与代理任务互斥、锁输入并共享可中止前台操作。
- 推理内容只显示在当前终端，不写入会话或审计；工具调用轮次必须把本轮推理字段送回模型。
- `web_search.limit` 默认 10，合法范围为 1..10。
- macOS、Linux、Windows Node 20 行为一致；标准版和单文件版一致。
- README 与 CHANGELOG 使用中文记录本轮功能，README 首屏“纯恶搞”警告不得削弱。

---

### Task 1: 分离供应商思考流与回答流

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/providers/openai-compatible.ts`
- Test: `tests/providers/openai-compatible.test.ts`

**Interfaces:**
- Produces: `ModelEvent` 新成员 `{type: 'reasoning_delta'; text: string}`。
- Produces: assistant `ModelMessage` 可选字段 `reasoning_content?: string`。
- Preserves: `{type: 'text_delta'; text: string}` 只代表最终回答。

- [ ] **Step 1: 写失败测试**

在 `tests/providers/openai-compatible.test.ts` 构造同一 SSE 中依次出现的：

```ts
{choices: [{delta: {reasoning_content: '先分析'}, finish_reason: null}]}
{choices: [{delta: {content: '再回答'}, finish_reason: null}]}
{choices: [{delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 2, completion_tokens: 3}}
```

断言事件顺序为：

```ts
[
  {type: 'reasoning_delta', text: '先分析'},
  {type: 'text_delta', text: '再回答'},
  {type: 'finish', reason: 'stop', usage: {inputTokens: 2, outputTokens: 3}},
]
```

- [ ] **Step 2: 验证 RED**

Run: `npx vitest run tests/providers/openai-compatible.test.ts`

Expected: FAIL，当前 `reasoning_content` 被丢弃。

- [ ] **Step 3: 最小实现**

给 `ChatCompletionChunk.choices[].delta` 增加：

```ts
reasoning_content?: string | null;
```

在 `content` 之前独立发出：

```ts
const reasoning = choice.delta?.reasoning_content;
if (typeof reasoning === 'string' && reasoning.length > 0) {
  yield {type: 'reasoning_delta', text: reasoning};
}
```

同步扩展 `ModelEvent` 和 assistant `ModelMessage` 类型。

- [ ] **Step 4: 验证 GREEN**

Run: `npx vitest run tests/providers/openai-compatible.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/providers/types.ts src/providers/openai-compatible.ts tests/providers/openai-compatible.test.ts
git commit -m "feat: 分离模型思考与回答流"
```

### Task 2: 代理循环保留推理字段并发出分流事件

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `src/cli/reducer.ts`
- Modify: `tests/helpers/scripted-model.ts`
- Test: `tests/agent/loop.test.ts`
- Test: `tests/cli/reducer.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `reasoning_delta`。
- Produces: `AgentEvent` / `AgentUiEvent` 的 `{type: 'reasoning_delta'; text: string}`。
- Produces: 工具调用 assistant 消息中的 `reasoning_content`。
- Preserves: 最终回答仍通过 `assistant_text` / `assistant_message` 完成事件定稿。

- [ ] **Step 1: 写失败测试**

在代理循环测试中脚本化：

```ts
{type: 'reasoning_delta', text: '检查协议'}
{type: 'text_delta', text: '开始回答'}
{type: 'tool_call_delta', index: 0, id: 'c1', name: 'read_file', arguments: '{"path":"README.md"}'}
{type: 'finish', reason: 'tool_calls', usage: undefined}
```

断言 UI 事件分别包含 reasoning 和 assistant delta，并断言下一轮模型消息为：

```ts
{
  role: 'assistant',
  reasoning_content: '检查协议',
  content: '开始回答',
  tool_calls: expect.any(Array),
}
```

在 reducer 测试中断言两个 delta 分别进入 `liveReasoning` 和 `liveAssistant`，不会写成同一个区块。

- [ ] **Step 2: 验证 RED**

Run: `npx vitest run tests/agent/loop.test.ts tests/cli/reducer.test.ts`

Expected: FAIL，类型和推理缓冲尚不存在。

- [ ] **Step 3: 最小实现**

代理每轮增加：

```ts
let reasoningText = '';
```

处理模型事件：

```ts
if (event.type === 'reasoning_delta') {
  reasoningText += event.text;
  yield {type: 'reasoning_delta', text: event.text};
}
```

工具调用 assistant 消息仅在非空时加入：

```ts
...(reasoningText === '' ? {} : {reasoning_content: reasoningText})
```

`UiState` 增加 `liveReasoning`、`liveAssistant`，delta 只追加对应实时缓冲，完整事件到达时定稿并清空。

- [ ] **Step 4: 验证 GREEN**

Run: `npx vitest run tests/agent/loop.test.ts tests/cli/reducer.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/agent/loop.ts src/cli/reducer.ts tests/helpers/scripted-model.ts tests/agent/loop.test.ts tests/cli/reducer.test.ts
git commit -m "feat: 在代理循环保留思考流"
```

### Task 3: 流式终端区块、阶段和增量 token

**Files:**
- Modify: `src/cli/app.tsx`
- Test: `tests/cli/app.test.tsx`

**Interfaces:**
- Consumes: `state.liveReasoning`、`state.liveAssistant` 和两类 delta。
- Produces: `StreamPhase = 'complete' | 'thinking' | 'answering'`。
- Produces: 当前任务 `streamTokenCount: number`，每个非空推理/回答 delta 加 1。

- [ ] **Step 1: 写失败测试**

用阻塞生成器依次发出：

```ts
yield {type: 'reasoning_delta', text: '先'};
yield {type: 'reasoning_delta', text: '想'};
yield {type: 'assistant_delta', text: '答'};
yield {type: 'assistant_delta', text: '案'};
```

逐阶段断言：

```text
思考 ›
先想
↓ 2 tokens · 思考中

浩宸 ›
答案
↓ 4 tokens · 思考完成 · 正在回答
```

释放生成器并断言最终为 `↓ 4 tokens · 思考完成`。再提交新任务，首帧必须从 `0 tokens` 重新开始。增加 content-only 模型测试，首个回答增量直接进入 answering。

- [ ] **Step 2: 验证 RED**

Run: `npx vitest run tests/cli/app.test.tsx`

Expected: FAIL，实时区块、阶段和计数尚未渲染。

- [ ] **Step 3: 最小实现**

增加：

```ts
type StreamPhase = 'complete' | 'thinking' | 'answering';
const [streamPhase, setStreamPhase] = useState<StreamPhase>('complete');
const [streamTokenCount, setStreamTokenCount] = useState(0);
```

新任务同步重置计数并设为 thinking。每个非空 reasoning delta 加一并保持 thinking；每个非空 assistant delta 加一并设为 answering。底部格式函数输出整数、`k` 或 `m`，渲染：

```tsx
<Text dimColor>{`↓ ${formatTokenCount(streamTokenCount)} tokens · ${phaseLabel(streamPhase)}`}</Text>
```

实时思考和回答分别使用 `思考 ›` 与 `浩宸 ›` 标题。

- [ ] **Step 4: 验证 GREEN**

Run: `npx vitest run tests/cli/app.test.tsx`

Expected: PASS，最终回答增量包含在 4 tokens 中。

- [ ] **Step 5: 提交**

```bash
git add src/cli/app.tsx tests/cli/app.test.tsx
git commit -m "feat: 显示流式思考与增量计数"
```

### Task 4: 锁定并可中止 `/compact`

**Files:**
- Modify: `src/cli/app.tsx`
- Modify: `src/cli/index.tsx`
- Test: `tests/cli/app.test.tsx`
- Test: `tests/cli/index.test.ts`

**Interfaces:**
- Changes: `compact?: (signal: AbortSignal) => Promise<CompactResult>`。
- Produces: 唯一 `ForegroundOperation`，区分 `agent` 与 `compact`。
- Produces: `CompactResult` 可选 `streamTokens?: number`，按摘要流的非空 reasoning/text delta 次数计算。

- [ ] **Step 1: 写失败测试**

构造等待 release 的 compact：

```ts
const compact = vi.fn(async (signal: AbortSignal) => {
  await Promise.race([blocked, aborted(signal)]);
  return {ok: true, message: '已压缩历史。', streamTokens: 3};
});
```

输入 `/compact` 后断言显示“正在压缩历史”和“输入已锁定”；继续写入 `是\r` 后断言 `runTask` 未调用且记录无“是”。第一次 `Ctrl+C` 应只让 compact signal aborted，不调用 `onExit`，并最终恢复输入。

- [ ] **Step 2: 验证 RED**

Run: `npx vitest run tests/cli/app.test.tsx tests/cli/index.test.ts`

Expected: FAIL，compact 仍无 signal 和前台状态。

- [ ] **Step 3: 最小实现**

把控制器 ref 改为：

```ts
type ForegroundOperation = {
  kind: 'agent' | 'compact';
  controller: AbortController;
};
```

`/compact` 同步注册操作、清零 token、设置 thinking 与 `正在压缩历史`，在 `finally` 清理。入口把 signal 原样传给 `model.stream`，统计非空 `reasoning_delta` / `text_delta` 次数并返回。压缩中止不调用代理任务的中断持久化回调。

- [ ] **Step 4: 验证 GREEN**

Run: `npx vitest run tests/cli/app.test.tsx tests/cli/index.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/cli/app.tsx src/cli/index.tsx tests/cli/app.test.tsx tests/cli/index.test.ts
git commit -m "fix: 锁定并可中止上下文压缩"
```

### Task 5: 超长单行文件字符分页

**Files:**
- Modify: `src/tools/files.ts`
- Modify: `src/cli/index.tsx`
- Modify: `src/security/boundary.ts`
- Test: `tests/tools/files.test.ts`
- Test: `tests/security/boundary.test.ts`
- Test: `tests/cli/index.test.ts`

**Interfaces:**
- Extends: `ReadFileInput` 增加 `startCharacter?: number`、`maxCharacters?: number`。
- Extends: `ReadFileOutput` 增加 `startCharacter`、`endCharacter`、`totalCharacters`、`nextCharacter?`。
- Defines: 字符偏移相对于保持同一行范围的规范化所选内容，按 Unicode 码点计数。

- [ ] **Step 1: 写失败测试**

替换“拒绝 2 MiB 单行”的错误契约，新增：

```ts
const text = `${'x'.repeat(65_535)}😀${'y'.repeat(5_000)}`;
await writeFile(file, text);
const first = await readFileTool({path: 'one-line.html'}, context, signal);
const second = await readFileTool({
  path: 'one-line.html',
  startCharacter: first.data!.nextCharacter,
}, context, signal);
expect(first.ok).toBe(true);
expect(first.data!.content).not.toContain('\uFFFD');
expect(first.data!.content + second.data!.content).toBe(text);
```

再验证单次最多 65,536 码点、范围外超长行不影响请求、2 MiB + 1 字节仍拒绝，以及 boundary 接受合法分页并拒绝负数、非整数和 `maxCharacters: 65537`。

- [ ] **Step 2: 验证 RED**

Run: `npx vitest run tests/tools/files.test.ts tests/security/boundary.test.ts tests/cli/index.test.ts`

Expected: FAIL，当前长行抛错且 Schema 不接受分页字段。

- [ ] **Step 3: 最小实现**

取消 `MAX_READ_LINE_CHARACTERS = READ_CHUNK_BYTES` 的逻辑行拒绝，但保留 `MAX_READ_BYTES`。选中行按现有 CR/LF 规则统一后：

```ts
const characters = Array.from(lines.join('\n'));
const startCharacter = input.startCharacter ?? 0;
const maxCharacters = input.maxCharacters ?? 65_536;
const endCharacter = Math.min(startCharacter + maxCharacters, characters.length);
const content = characters.slice(startCharacter, endCharacter).join('');
```

验证范围并返回 continuation 元数据。同步更新 Zod、JSON Schema、模型工具描述和 boundary 的 `onlyKeys`、规范化输入、范围与指纹。

- [ ] **Step 4: 验证 GREEN**

Run: `npx vitest run tests/tools/files.test.ts tests/security/boundary.test.ts tests/cli/index.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools/files.ts src/cli/index.tsx src/security/boundary.ts tests/tools/files.test.ts tests/security/boundary.test.ts tests/cli/index.test.ts
git commit -m "fix: 支持超长单行文件续读"
```

### Task 6: 统一 `web_search.limit` 协议

**Files:**
- Modify: `src/cli/index.tsx`
- Modify: `src/security/boundary.ts`
- Test: `tests/security/boundary.test.ts`
- Test: `tests/tools/registry.test.ts`
- Test: `tests/cli/index.test.ts`

**Interfaces:**
- Preserves: `WebSearchInput {query: string; limit?: number}`。
- Defines: boundary 规范化后始终为 `{query: string; limit: number}`。

- [ ] **Step 1: 写失败测试**

断言：

```ts
const five = await classifyOperation({
  tool: 'web_search',
  input: {query: '苏浩宸', limit: 5},
}, context);
expect(five.action).toBe('allow');
expect(five.normalizedScope).toContain('search:苏浩宸:5');
```

补充 0、11、1.5 拒绝，不同 limit 指纹不同，以及工具公开 Schema 的 `minimum: 1` / `maximum: 10`。

- [ ] **Step 2: 验证 RED**

Run: `npx vitest run tests/security/boundary.test.ts tests/tools/registry.test.ts tests/cli/index.test.ts`

Expected: FAIL，boundary 报告未知字段 `limit`。

- [ ] **Step 3: 最小实现**

`normalizeWebTool` 改为：

```ts
onlyKeys(input, ['query', 'limit'], `${tool} input`);
const limit = optionalInteger(input.limit, 'limit', 10, 1, 10);
return {
  input: {query, limit},
  scope: [`search:${query}:${limit}`],
  ...
};
```

Zod 使用 `.min(1).max(10)`，JSON Schema 增加 `minimum` 与 `maximum`。

- [ ] **Step 4: 验证 GREEN**

Run: `npx vitest run tests/security/boundary.test.ts tests/tools/registry.test.ts tests/cli/index.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/cli/index.tsx src/security/boundary.ts tests/security/boundary.test.ts tests/tools/registry.test.ts tests/cli/index.test.ts
git commit -m "fix: 统一联网搜索参数边界"
```

### Task 7: 文档、构建、本机安装与跨平台验证

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Verify: `dist/cli.mjs`
- Verify: `dist/haochen-onefile.mjs`

**Interfaces:**
- Documents: 长行续读、搜索 limit、compact 锁定、思考/回答流和“一个流增量计一个 token”的准确语义。

- [ ] **Step 1: 更新中文文档**

README 明确写入：

```text
“思考 ›”来自供应商返回的 reasoning_content，“浩宸 ›”来自 content。
底部 tokens 是非空推理/回答流增量次数，不是 tokenizer 的真实分词数量。
read_file 会为超长单行返回 nextCharacter，代理可保持相同行范围续读。
```

CHANGELOG 在“新增/修复”下记录四项功能和根因，不删除首屏恶搞警告。

- [ ] **Step 2: 全量本地验证**

Run:

```bash
npm test
npm run typecheck
npm run build
node dist/cli.mjs --version
node dist/haochen-onefile.mjs --version
git diff --check
```

Expected: 退出码全部为 0；两个入口输出 `0.1.0`。

- [ ] **Step 3: 打包并全局安装**

Run:

```bash
npm pack --pack-destination outputs
npm install --global outputs/haochen-signal-0.1.0.tgz
haochen --version
```

Expected: 全局入口输出 `0.1.0`。

- [ ] **Step 4: 提交文档并推送**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: 记录流式状态与工具修复"
git push origin main
```

- [ ] **Step 5: 验证 GitHub Actions**

Run: `gh run watch --repo hedssaz/haochen-signal --exit-status`

Expected: `windows-latest`、`ubuntu-latest`、`macos-latest` 的 Node 20 测试、类型检查、构建和版本入口全部成功。

- [ ] **Step 6: 独立 review**

审查完整差异，重点核对：

- 推理字段不会写入持久日志；
- 最终回答增量全部计数且不重复渲染；
- compact 取消不会误写代理中断；
- 字符分页不能拆 Unicode 码点或绕过工作区边界；
- web limit 的模型、边界和执行值完全一致。

若发现 Critical 或 Important 问题，先补失败测试、修复、提交、推送并重新跑三平台 CI，再进行最终复审。
