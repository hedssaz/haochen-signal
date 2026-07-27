# 工具计数与上限收尾 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在运行状态行显示本任务真实工具调用次数，并在工具预算耗尽后让 Agent 完成一次禁止工具的最终说明。

**Architecture:** `UiState` 负责按 `task_started` 和 `tool_started` 维护真实执行计数，`App` 只负责展示由 CLI 传入的最大值。主代理循环在预算耗尽时为同批未执行调用补齐失败结果，再追加内部收尾指令并执行一次不带工具定义的额外模型请求。

**Tech Stack:** TypeScript、React、Ink、Vitest

## Global Constraints

- 每个任务开始时工具计数归零，每个真实 `tool_started` 只增加一次。
- 黄色状态行显示 `工具 当前次数/上限 次`，工具详情继续保持现有单行与自动收起行为。
- 超出预算的调用不执行、不计数，但必须补齐模型工具调用协议。
- 工具预算耗尽后最多额外发起一次 `toolChoice: none` 的收尾请求。
- 轮次上限、用户中止、网络错误和工具执行错误保持现有行为。
- 不新增依赖，不增加配置项，不重构无关代码。

---

### Task 1: 统计并显示本任务工具调用次数

**Files:**
- Modify: `src/cli/reducer.ts`
- Modify: `src/cli/app.tsx`
- Modify: `src/cli/index.tsx`
- Test: `tests/cli/reducer.test.ts`
- Test: `tests/cli/app.test.tsx`

**Interfaces:**
- Consumes: `UiEvent` 中现有的 `task_started` 和 `tool_started`
- Produces: `UiState.toolCallCount: number`、`AppProps.maxToolCalls?: number`

- [ ] **Step 1: 写 reducer 失败测试**

在 `tests/cli/reducer.test.ts` 新增测试，先制造上一任务计数，再开始新任务并调用两个工具：

```ts
it('resets and counts real tool starts for each task', () => {
  const previous = {
    ...initialUiState,
    toolCallCount: 7,
  };
  const started = uiReducer(previous, {type: 'task_started'});
  const first = uiReducer(started, {
    type: 'tool_started',
    name: 'read_file',
    input: {path: 'README.md'},
  });
  const second = uiReducer(first, {
    type: 'tool_started',
    name: 'git_status',
    input: {},
  });

  expect(started.toolCallCount).toBe(0);
  expect(first.toolCallCount).toBe(1);
  expect(second.toolCallCount).toBe(2);
});
```

- [ ] **Step 2: 运行 reducer 测试并确认失败**

Run: `npm test -- --run tests/cli/reducer.test.ts`

Expected: FAIL，`UiState` 尚无 `toolCallCount`，或实际值为 `undefined`。

- [ ] **Step 3: 写 reducer 最小实现**

在 `UiState` 和 `initialUiState` 中增加：

```ts
toolCallCount: number;
```

```ts
toolCallCount: 0,
```

在 `task_started` 返回值中重置：

```ts
toolCallCount: 0,
```

在 `tool_started` 的状态覆盖中递增：

```ts
toolCallCount: state.toolCallCount + 1,
```

- [ ] **Step 4: 运行 reducer 测试并确认通过**

Run: `npm test -- --run tests/cli/reducer.test.ts`

Expected: PASS。

- [ ] **Step 5: 写 App 状态行失败测试**

在 `tests/cli/app.test.tsx` 的持续运行状态测试中给 `App` 传入 `maxToolCalls={32}`，并在第一个工具开始后断言：

```ts
expect(app.lastFrame()).toContain(
  '状态 › 运行中 · 正在调用 read_file · 工具 1/32 次 · Ctrl+C 中止',
);
```

再增加两个连续 `tool_started` 的用例，断言第二次显示 `工具 2/5 次`，任务结束后状态行仍按现有行为消失。

- [ ] **Step 6: 运行 App 测试并确认失败**

Run: `npm test -- --run tests/cli/app.test.tsx`

Expected: FAIL，当前状态行没有工具计数。

- [ ] **Step 7: 传入上限并渲染计数**

在 `AppProps` 中增加：

```ts
maxToolCalls?: number;
```

状态行改为：

```tsx
{`状态 › 运行中 · ${runtimeStatus} · 工具 ${state.toolCallCount}/${props.maxToolCalls ?? 32} 次 · Ctrl+C 中止`}
```

在 `src/cli/index.tsx` 定义并复用：

```ts
const MAX_AGENT_TURNS = 16;
const MAX_AGENT_TOOL_CALLS = 32;
```

把 `runAgentTask` 的限制改为：

```ts
limits: {
  maxTurns: MAX_AGENT_TURNS,
  maxToolCalls: MAX_AGENT_TOOL_CALLS,
},
```

并给 `App` 传入：

```tsx
maxToolCalls={MAX_AGENT_TOOL_CALLS}
```

- [ ] **Step 8: 运行 Task 1 测试并提交**

Run: `npm test -- --run tests/cli/reducer.test.ts tests/cli/app.test.tsx`

Expected: PASS。

```bash
git add src/cli/reducer.ts src/cli/app.tsx src/cli/index.tsx tests/cli/reducer.test.ts tests/cli/app.test.tsx
git commit -m "feat: 显示本轮工具调用次数"
```

### Task 2: 工具上限后执行一次无工具收尾

**Files:**
- Modify: `src/agent/loop.ts`
- Test: `tests/agent/loop.test.ts`

**Interfaces:**
- Consumes: `RunAgentTaskOptions.limits.maxToolCalls`、现有 `ModelRequest.toolChoice`
- Produces: 工具预算耗尽后的单次 `tools: undefined`、`toolChoice: 'none'` 收尾请求

- [ ] **Step 1: 把现有上限测试改成目标行为并确认失败**

将“执行恰好 `maxToolCalls` 后停止”的测试改为使用 `recordingModel` 提供工具批次和最终文本：

```ts
const model = recordingModel([
  toolResponse([
    {id: 'call_1', name: 'read_file', arguments: {path: 'README.md'}},
    {id: 'call_2', name: 'read_file', arguments: {path: 'README.md'}},
  ]),
  textResponse('已读取一个文件，其余文件因工具上限未读取。'),
]);

const events = await collect(runAgentTask(options(model.client, {
  limits: {maxTurns: 1, maxToolCalls: 1},
})));

expect(executeRead).toHaveBeenCalledTimes(1);
expect(events).toContainEqual({
  type: 'status',
  text: '工具调用已达上限，正在整理最终回答',
});
expect(events.at(-1)).toEqual({
  type: 'assistant_text',
  text: '已读取一个文件，其余文件因工具上限未读取。',
});
expect(model.requests).toHaveLength(2);
expect(model.requests[1]).toMatchObject({toolChoice: 'none'});
expect(model.requests[1]?.tools).toBeUndefined();
expect(model.requests[1]?.messages).toContainEqual({
  role: 'tool',
  tool_call_id: 'call_2',
  content: expect.stringContaining('TOOL_LIMIT_REACHED'),
});
```

- [ ] **Step 2: 增加收尾轮拒绝继续调用工具的失败测试**

```ts
const events = await collect(runAgentTask(options(scriptedModel([
  toolResponse([{
    id: 'call_1',
    name: 'read_file',
    arguments: {path: 'README.md'},
  }]),
  toolResponse([{
    id: 'call_2',
    name: 'read_file',
    arguments: {path: 'README.md'},
  }]),
]), {
  limits: {maxTurns: 1, maxToolCalls: 1},
})));

expect(executeRead).toHaveBeenCalledOnce();
expect(events.at(-1)).toEqual({
  type: 'error',
  message: '工具调用上限后的最终回答仍请求了工具',
});
```

- [ ] **Step 3: 运行 Agent 测试并确认失败**

Run: `npm test -- --run tests/agent/loop.test.ts`

Expected: FAIL，当前循环在溢出调用前直接发出 `limit_reached` 并返回。

- [ ] **Step 4: 增加上限结果和收尾状态**

在 `src/agent/loop.ts` 增加固定结果：

```ts
function toolLimitResult(): ToolResult {
  return {
    ok: false,
    summary: '工具调用上限已达到，本次调用未执行',
    error: {
      code: 'TOOL_LIMIT_REACHED',
      message: '工具调用上限已达到，本次调用未执行',
    },
  };
}
```

在循环状态中增加：

```ts
let finalizingAfterToolLimit = false;
```

模型请求改为：

```ts
const finalizing = finalizingAfterToolLimit;
const iterator = options.model.stream({
  model: modelName,
  messages,
  tools: finalizing ? undefined : tools,
  toolChoice: finalizing ? 'none' : allowTools ? 'auto' : 'none',
}, options.signal)[Symbol.asyncIterator]();
```

只有普通轮次检查并累计 `maxTurns`；收尾轮额外允许一次：

```ts
if (!finalizingAfterToolLimit && turns >= maxTurns) {
  yield {type: 'limit_reached', limit: 'turns'};
  return;
}
if (!finalizingAfterToolLimit) turns += 1;
```

解析完成后拒绝收尾轮的新工具调用：

```ts
if (finalizing && hasToolCalls) {
  yield {
    type: 'error',
    message: '工具调用上限后的最终回答仍请求了工具',
  };
  return;
}
```

- [ ] **Step 5: 在预算耗尽时补齐结果并进入收尾轮**

处理 `batch.prepared` 时使用索引。每执行一个真实工具后，如果 `toolCallCount === maxToolCalls`，对当前批次剩余调用逐个：

```ts
const result = toolLimitResult();
await appendSessionEvent(options.session, {
  type: 'tool',
  at: Date.now(),
  tool: pending.toolCall.function.name,
  input: pending.input,
  result,
}, options.signal);
messages.push({
  role: 'tool',
  tool_call_id: pending.toolCall.id,
  content: serializeResult(result),
});
```

若预算在批次开始前已为零，同样处理整批。然后追加：

```ts
messages.push({
  role: 'system',
  content: [
    '工具调用上限已达到，后续不得再调用工具。',
    '请仅根据已有对话和工具结果，向用户总结已完成内容、当前结论与未完成项。',
  ].join('\n'),
});
finalizingAfterToolLimit = true;
yield {
  type: 'status',
  text: '工具调用已达上限，正在整理最终回答',
};
```

退出当前工具批次并进入下一次 `while`，最终纯文本响应沿用现有保存与 `assistant_text` 事件。

- [ ] **Step 6: 运行 Agent 测试并确认通过**

Run: `npm test -- --run tests/agent/loop.test.ts`

Expected: PASS；真实工具仅执行到上限，额外模型请求没有工具定义。

- [ ] **Step 7: 提交 Task 2**

```bash
git add src/agent/loop.ts tests/agent/loop.test.ts
git commit -m "feat: 工具上限后完成无工具收尾"
```

### Task 3: 文档、完整验证与全局安装

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1 的状态行、Task 2 的收尾行为
- Produces: 用户可查阅的中文行为说明与已验证全局命令

- [ ] **Step 1: 更新中文文档**

在 README 的终端交互说明中加入：

```md
- 运行状态持续显示本任务真实工具调用次数与上限；工具预算耗尽后，Agent 会停止调用工具并基于已有结果完成一次最终说明。
```

在 CHANGELOG `[未发布]` 的“新增”中加入：

```md
- 新增本任务工具调用计数与上限收尾：黄色运行状态显示当前次数/上限；预算耗尽后补齐未执行调用的协议结果，并以一次禁止工具的模型请求总结进度和未完成项。
```

- [ ] **Step 2: 运行完整验证**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 41 个测试文件全部通过，TypeScript 无错误，构建成功，`git diff --check` 无输出。

- [ ] **Step 3: 提交文档**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: 记录工具计数与上限收尾"
```

- [ ] **Step 4: 刷新全局命令并核验**

Run:

```bash
npm install -g .
/opt/homebrew/bin/haochen --version
```

Expected: 安装成功并输出 `0.1.0`。
