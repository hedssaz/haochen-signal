# 终端分区与工作区会话恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为浩宸信号增加清晰的用户、代理、工具、审批、结果和状态分区，并让 `/resume` 通过当前工作区的交互列表恢复会话。

**Architecture:** 用纯函数生成脱敏参数摘要，用结构化 `ToolGateEvent` 报告执行门过程，用向后兼容的 `session_meta` 事件绑定工作区哈希。React/Ink 层只消费结构化记录和会话摘要，按类别渲染并维护 Resume 选择器。

**Tech Stack:** TypeScript 7、Node.js 20+、React 19、Ink 6、Zod 4、Vitest 4。

## Global Constraints

- 不记录真实工作区路径，只记录绝对路径的 SHA-256 摘要。
- 工具参数必须先脱敏，再限制为最长 240 个可见字符。
- `apply_patch` 不显示补丁正文；凭据始终显示为 `[REDACTED]`。
- 每个工具调用都显示真实的边界、AI 审查或人工确认结果，不得把直接放行写成 AI 审批通过。
- 旧会话保持可读，并归入“工作区未知”。
- README 与 CHANGELOG 使用中文；每个任务完成后提交 Git。

---

### Task 1: 安全工具参数摘要与记录类别

**Files:**
- Create: `src/cli/tool-summary.ts`
- Create: `tests/cli/tool-summary.test.ts`
- Modify: `src/cli/reducer.ts`
- Modify: `tests/cli/reducer.test.ts`

**Interfaces:**
- Consumes: `redactValue(value: unknown): unknown`
- Produces: `summarizeToolInput(tool: string, input: unknown, limit?: number): string`
- Produces: `UiEntry` 的 `kind: 'user' | 'assistant' | 'tool' | 'result' | 'approval' | 'status' | 'review' | 'error' | 'success'`

- [ ] **Step 1: 写参数摘要失败测试**

```ts
expect(summarizeToolInput('read_file', {
  path: 'README.md',
  authorization: 'Bearer secret',
})).toBe('{"path":"README.md","authorization":"[REDACTED]"}');
expect(summarizeToolInput('apply_patch', {
  operations: [{type: 'update', path: 'src/a.ts', replacement: 'very long'}],
})).toBe('{"operations":[{"type":"update","path":"src/a.ts"}]}');
expect(summarizeToolInput('read_file', {text: 'x'.repeat(500)}).length).toBeLessThanOrEqual(240);
```

- [ ] **Step 2: 验证测试因模块不存在而失败**

Run: `npx vitest run tests/cli/tool-summary.test.ts`
Expected: FAIL，提示无法导入 `src/cli/tool-summary.js`。

- [ ] **Step 3: 实现脱敏、结构压缩和长度限制**

```ts
export function summarizeToolInput(
  tool: string,
  input: unknown,
  limit = 240,
): string {
  const safe = tool === 'apply_patch'
    ? summarizePatch(redactValue(input))
    : redactValue(input);
  return truncateVisible(safeJson(safe), limit);
}
```

`summarizePatch` 只保留 `operations[].type` 与 `operations[].path`；`safeJson` 捕获序列化错误并返回 `[无法摘要]`；`truncateVisible` 使用 `Array.from` 按码点截断并保留结尾 `…`。

- [ ] **Step 4: 写 reducer 类别失败测试**

```ts
const tool = uiReducer(initialUiState, {
  type: 'tool_started',
  name: 'read_file',
  input: {path: 'README.md'},
});
expect(tool.transcript.at(-1)).toMatchObject({
  kind: 'tool',
  title: 'read_file',
  detail: '{"path":"README.md"}',
});
```

- [ ] **Step 5: 将 `UiEntry` 改为明确类别并映射代理事件**

```ts
export interface UiEntry {
  kind: UiEntryKind;
  title: string;
  text: string;
  detail?: string;
}
```

`assistant_message` 与 `assistant_text` 使用 `assistant`；`tool_started` 使用 `tool`；`tool_finished` 使用 `result`；`status` 使用 `status`；失败使用 `error`；用户提交使用 `user`。

- [ ] **Step 6: 运行定向测试**

Run: `npx vitest run tests/cli/tool-summary.test.ts tests/cli/reducer.test.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/cli/tool-summary.ts src/cli/reducer.ts tests/cli/tool-summary.test.ts tests/cli/reducer.test.ts
git commit -m "feat: 区分终端记录并摘要工具参数"
```

### Task 2: 执行门审批事件

**Files:**
- Modify: `src/tools/registry.ts`
- Modify: `src/tools/types.ts`
- Modify: `tests/tools/registry.test.ts`
- Modify: `src/agent/loop.ts`
- Modify: `tests/agent/loop.test.ts`

**Interfaces:**
- Produces: `ToolGateEvent`
- Produces: `ToolExecutionContext.reportGate?: (event: ToolGateEvent) => void`
- Produces: `RunAgentTaskOptions.reportGate?: (event: ToolGateEvent) => void`

- [ ] **Step 1: 写各决策路径的失败测试**

```ts
const events: ToolGateEvent[] = [];
await registry.execute('run_command', input, {
  ...context,
  reportGate: event => events.push(event),
});
expect(events).toContainEqual(expect.objectContaining({
  type: 'review_finished',
  tool: 'run_command',
  verdict: 'approve',
}));
expect(events.at(-1)).toMatchObject({
  type: 'gate_finished',
  outcome: 'execute',
  source: 'ai_review',
});
```

分别覆盖 `allow`、`deny`、AI `approve`、AI `deny`、`ask_user`、三种人工结果、会话许可和范围漂移。

- [ ] **Step 2: 验证测试失败**

Run: `npx vitest run tests/tools/registry.test.ts`
Expected: FAIL，`reportGate` 或 `ToolGateEvent` 尚不存在。

- [ ] **Step 3: 定义并在所有提前返回前报告真实决策**

```ts
export type ToolGateEvent =
  | {type: 'classified'; tool: string; action: BoundaryAction; risk: BoundaryRisk; reason: string}
  | {type: 'review_started'; tool: string}
  | {type: 'review_finished'; tool: string; verdict: ReviewDecision['verdict']; risk: BoundaryRisk; summary: string}
  | {type: 'confirmation_finished'; tool: string; result: ConfirmationResult}
  | {type: 'gate_finished'; tool: string; outcome: 'execute' | 'deny'; source: GateSource; summary: string};
```

用局部 `report(event)` 包装可选回调并捕获回调异常。直接放行报告 `source: 'boundary_allow'`；会话许可报告 `session_grant`；AI 审查、人工确认与范围漂移使用各自准确来源。

- [ ] **Step 4: 让 agent loop 把报告事件实时送往 UI**

在 `RunAgentTaskOptions` 增加 `reportGate`，传给 `registry.execute`；报告器由 CLI 侧事件总线消费，不改变模型工具结果和会话 JSONL。

- [ ] **Step 5: 运行 registry 与 agent loop 测试**

Run: `npx vitest run tests/tools/registry.test.ts tests/agent/loop.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/tools/registry.ts src/tools/types.ts src/agent/loop.ts tests/tools/registry.test.ts tests/agent/loop.test.ts
git commit -m "feat: 展示工具执行门审批过程"
```

### Task 3: 工作区会话元数据与安全列表

**Files:**
- Modify: `src/sessions/types.ts`
- Modify: `src/sessions/store.ts`
- Modify: `tests/sessions/store.test.ts`
- Modify: `src/cli/index.tsx`

**Interfaces:**
- Consumes: 现有 `workspaceId(workspace: string): string`
- Produces: `SessionEvent` 变体 `{type: 'session_meta'; at: number; workspaceId: string}`
- Produces: `SessionInfo {id; updatedAt; preview; workspaceId?}`
- Produces: `SessionStore.initialize(sessionId: string, workspaceId: string): Promise<void>`

- [ ] **Step 1: 写元数据、过滤、预览和旧会话失败测试**

```ts
await store.initialize('current', 'workspace-a');
await store.append('current', {type: 'user', at: 2, text: '修复登录问题'});
await store.append('other', {type: 'session_meta', at: 1, workspaceId: 'workspace-b'});
await store.append('legacy', {type: 'user', at: 3, text: '旧会话'});

expect(await store.list()).toEqual(expect.arrayContaining([
  expect.objectContaining({id: 'current', preview: '修复登录问题', workspaceId: 'workspace-a'}),
  expect.objectContaining({id: 'legacy', preview: '旧会话', workspaceId: undefined}),
]));
```

- [ ] **Step 2: 验证测试失败**

Run: `npx vitest run tests/sessions/store.test.ts`
Expected: FAIL，schema 不接受 `session_meta` 或 `initialize` 不存在。

- [ ] **Step 3: 扩展 schema 与列表摘要**

`session_meta` 使用严格对象，只接受 64 位小写十六进制 `workspaceId`。`initialize` 对空会话写入一次元数据，对已有相同元数据保持幂等，对冲突元数据抛错。`list` 从第一条元数据和第一条非空用户消息生成摘要，预览最长 80 个码点。

- [ ] **Step 4: 在主界面渲染前初始化会话**

```ts
const currentWorkspaceId = workspaceId(workspace);
let sessionId = createSessionId();
await store.initialize(sessionId, currentWorkspaceId);
```

`createSession` 同样先初始化再把 ID 返回给 App。

- [ ] **Step 5: 运行会话与入口相关测试、类型检查**

Run: `npx vitest run tests/sessions/store.test.ts tests/cli/app.test.tsx && npm run typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/sessions/types.ts src/sessions/store.ts src/cli/index.tsx tests/sessions/store.test.ts
git commit -m "feat: 按工作区索引会话"
```

### Task 4: `/resume` 交互选择器

**Files:**
- Create: `src/cli/resume-picker.ts`
- Create: `tests/cli/resume-picker.test.ts`
- Modify: `src/cli/app.tsx`
- Modify: `tests/cli/app.test.tsx`
- Modify: `src/cli/index.tsx`

**Interfaces:**
- Produces: `ResumePickerState {items; selectedIndex; windowStart}`
- Produces: `moveResumeSelection(state, delta, windowSize): ResumePickerState`
- `AppProps.listSessions` 返回扩展后的 `SessionInfo[]`

- [ ] **Step 1: 写选择、滚动窗口和分组失败测试**

```ts
const picker = createResumePicker(items, 'workspace-a', 8);
expect(picker.items.map(item => item.group)).toEqual([
  'current', 'current', 'legacy',
]);
expect(moveResumeSelection(picker, 1, 8).selectedIndex).toBe(1);
```

- [ ] **Step 2: 验证纯函数测试失败**

Run: `npx vitest run tests/cli/resume-picker.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纯选择器状态**

当前工作区条目排在前面，旧会话排在第二组；保留每组内部的更新时间顺序。移动选择时循环到首尾，并把所选项保持在固定渲染窗口内。

- [ ] **Step 4: 写 Ink 交互失败测试**

```ts
app.stdin.write('/resume');
app.stdin.write('\r');
await vi.waitFor(() => expect(app.lastFrame()).toContain('恢复对话 · 当前工作区'));
app.stdin.write('\u001B[B');
app.stdin.write('\r');
await vi.waitFor(() => expect(resumeSession).toHaveBeenCalledWith('session-2'));
```

另测 `Esc` 关闭、不带会话的空状态和 `/resume <ID>` 兼容。

- [ ] **Step 5: 接线选择器**

`/resume` 异步加载全部摘要并打开 picker。按键优先级为：人工确认、Resume picker、任务输入。选择器行显示 `› 07-25 16:40  修复登录问题  · ab12cd34`；旧会话带“工作区未知”标题。`Enter` 成功恢复后关闭 picker，失败时保留当前会话并显示错误。

- [ ] **Step 6: 运行 Resume 测试**

Run: `npx vitest run tests/cli/resume-picker.test.ts tests/cli/app.test.tsx`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/cli/resume-picker.ts src/cli/app.tsx src/cli/index.tsx tests/cli/resume-picker.test.ts tests/cli/app.test.tsx
git commit -m "feat: 增加工作区会话选择器"
```

### Task 5: 分区渲染、审批订阅与持续状态

**Files:**
- Create: `src/cli/gate-reporter.ts`
- Create: `tests/cli/gate-reporter.test.ts`
- Modify: `src/cli/app.tsx`
- Modify: `tests/cli/app.test.tsx`
- Modify: `src/cli/index.tsx`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `GateReporter`，提供 `report`、`subscribe` 和 `getEvents`
- Consumes: `ToolGateEvent`、分类后的 `UiEntry`、Resume picker

- [ ] **Step 1: 写报告器和 UI 失败测试**

验证订阅者收到审批事件且异常订阅者不影响后续订阅者。Ink 测试断言：

```ts
expect(frame).toContain('你 ›');
expect(frame).toContain('浩宸 ›');
expect(frame).toContain('工具 › read_file');
expect(frame).toContain('参数  {"path":"README.md"}');
expect(frame).toContain('审批 › read_file');
expect(frame).toContain('AI 自动审查通过');
expect(frame).toContain('结果 › read_file');
expect(frame).toContain('状态 › 运行中 · 正在调用 read_file · Ctrl+C 中止');
```

- [ ] **Step 2: 验证 UI 测试失败**

Run: `npx vitest run tests/cli/gate-reporter.test.ts tests/cli/app.test.tsx`
Expected: FAIL，报告器或新分区尚不存在。

- [ ] **Step 3: 实现报告器与 App 订阅**

报告器只保留当前任务事件；每个工具的 `gate_finished` 转换为一条 `approval` 记录。中间的 `review_started` 更新持续状态，`review_finished`、`confirmation_finished` 和最终结果写入审批分区。

- [ ] **Step 4: 实现紧凑分区渲染**

用 `UiEntry.kind` 选择标题、颜色和正文。每条记录之间留一行；工具参数使用 dimColor；用户为 cyan，代理为 white，工具为 magenta，审批为 yellow，结果成功为 green，错误为 red。底部在活动任务期间持续显示运行状态，任务结束立即移除。

- [ ] **Step 5: 更新中文文档**

README 增加终端前缀示例、参数脱敏规则、审批语义、运行状态和 `/resume` 键位。CHANGELOG 在“未发布”下记录本次功能。

- [ ] **Step 6: 全量验证和真实 TTY 验收**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全部退出码为 0。

真实 TTY：启动 `node dist/cli.mjs`，输入 `/resume` 验证选择器；执行低风险读取与需审查命令，确认分别显示“边界直接放行”和“AI 自动审查”结果；确认任务运行状态在完成后消失。

- [ ] **Step 7: 提交**

```bash
git add src/cli/gate-reporter.ts src/cli/app.tsx src/cli/index.tsx tests/cli/gate-reporter.test.ts tests/cli/app.test.tsx README.md CHANGELOG.md
git commit -m "feat: 完成终端分区与运行状态"
```

### Task 6: 重新打包并覆盖本机安装

**Files:**
- Generated: `dist/cli.mjs`
- Generated: `dist/haochen-onefile.mjs`
- Generated: `outputs/haochen-signal-0.1.0.tgz`
- Generated: `outputs/haochen-signal-cli.mjs`
- Generated: `outputs/haochen-onefile.mjs`
- Generated: `outputs/haochen-signal-v0.1.0-source.tar.gz`

**Interfaces:**
- Consumes: 所有前述任务的已提交源码
- Produces: 本机 `/opt/homebrew/bin/haochen`

- [ ] **Step 1: 运行最终发布验证**

Run: `npm test && npm run typecheck && npm run build && env npm_config_cache=/tmp/haochen-npm-cache npm pack --pack-destination outputs`
Expected: 全部通过，npm 包只含 5 个白名单文件。

- [ ] **Step 2: 更新所有交付物**

```bash
cp dist/cli.mjs outputs/haochen-signal-cli.mjs
cp dist/haochen-onefile.mjs outputs/haochen-onefile.mjs
git archive --format=tar.gz -o outputs/haochen-signal-v0.1.0-source.tar.gz HEAD
```

- [ ] **Step 3: 覆盖全局安装**

Run: `npm install -g /Users/hedssaz/Documents/Codex/2026-07-25/new-chat/outputs/haochen-signal-0.1.0.tgz`
Expected: `changed 68 packages` 或等价成功信息。

- [ ] **Step 4: 验证全局命令**

Run: `haochen --version`
Expected: `0.1.0`。

真实 TTY 中验证 `/resume`、工具参数、审批结果、输入/输出边界和持续运行状态均来自 `/opt/homebrew/bin/haochen`。
