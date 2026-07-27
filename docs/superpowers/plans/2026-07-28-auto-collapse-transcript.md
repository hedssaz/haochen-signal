# 自动收起执行过程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每次工具调用只占一行，并在任意非空回答开始流式输出时收起当前任务此前的执行过程。

**Architecture:** 在 `UiState` 中记录当前任务的转录起点；reducer 在 `assistant_delta` 到达时过滤该起点之后的过程条目。工具开始与结束共用同一条 `UiEntry`，Ink 渲染器对该条目使用单行布局。

**Tech Stack:** TypeScript、React、Ink、Vitest

## Global Constraints

- 仅改变当前进程的终端展示，不删除会话、审计或模型上下文。
- 不区分回答是否最终回答；每个非空回答增量都确保本轮此前过程已收起。
- 工具运行期间保留可见反馈，工具结束后在原行显示成功或失败摘要。
- 不增加配置项、依赖或无关重构。

---

### Task 1: Reducer 收起过程并合并工具状态

**Files:**
- Modify: `src/cli/reducer.ts`
- Test: `tests/cli/reducer.test.ts`

**Interfaces:**
- Consumes: 现有 `UiEvent` 中的 `task_started`、`assistant_delta`、`tool_started`、`tool_finished`
- Produces: `UiState.taskTranscriptStart?: number`；工具条目的 `compact` 与 `toolStatus`

- [ ] **Step 1: 写失败测试**

新增测试，验证：

```ts
expect(answering.transcript).toEqual([
  {kind: 'assistant', title: '浩宸', text: '之前的回答'},
]);
expect(answering.liveReasoning).toBe('');
expect(answering.liveAssistant).toBe('现在回答');
```

并验证工具开始、成功和失败始终复用同一条转录记录：

```ts
expect(finished.transcript).toHaveLength(1);
expect(finished.transcript[0]).toMatchObject({
  kind: 'tool',
  compact: true,
  toolStatus: 'success',
});
```

- [ ] **Step 2: 运行 reducer 测试并确认失败**

Run: `npm test -- tests/cli/reducer.test.ts`

Expected: FAIL，原因是当前 reducer 保留过程条目并追加独立结果条目。

- [ ] **Step 3: 写最小实现**

在 `task_started` 时保存 `state.transcript.length`。对非空 `assistant_delta`，清空 `liveReasoning`，并过滤任务起点之后这些类型：

```ts
const processKinds = new Set<UiEntryKind>([
  'reasoning', 'tool', 'result', 'approval', 'review', 'status',
]);
```

工具开始时写入：

```ts
{kind: 'tool', compact: true, toolStatus: 'pending'}
```

工具结束时从后向前找到同名 `pending` 条目，原位更新为 `success` 或 `failure`；找不到时保留现有独立结果回退。

- [ ] **Step 4: 运行 reducer 测试并确认通过**

Run: `npm test -- tests/cli/reducer.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/cli/reducer.ts tests/cli/reducer.test.ts
git commit -m "feat: 自动收起本轮执行过程"
```

### Task 2: 单行渲染、文档与完整验证

**Files:**
- Modify: `src/cli/app.tsx`
- Modify: `tests/cli/app.test.tsx`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1 生成的 `UiEntry.compact` 与 `UiEntry.toolStatus`
- Produces: 工具调用的单行 Ink 输出

- [ ] **Step 1: 写失败渲染测试**

构造工具开始与结束事件，断言最终帧包含一条组合文本：

```ts
expect(frame).toContain('工具 › read_file · 读取碎片');
expect(frame).toContain('✓');
expect(frame.match(/read_file/g)).toHaveLength(1);
```

再构造思考、工具和回答增量，断言回答出现后帧中不再包含本轮思考与工具文本。

- [ ] **Step 2: 运行 App 测试并确认失败**

Run: `npm test -- tests/cli/app.test.tsx`

Expected: FAIL，原因是工具仍按标题、正文、参数多行渲染。

- [ ] **Step 3: 写最小渲染实现**

对 `item.compact === true` 使用单个 `<Text>`：

```tsx
<Text color={entryColor(item)}>
  {`${entryLabel(item)} · ${item.text}${item.detail ? ` · ${item.detail}` : ''}`}
</Text>
```

其余条目保持现有布局。README 和 CHANGELOG 用中文记录自动收起与单行工具显示行为。

- [ ] **Step 4: 运行专项与全量验证**

Run:

```bash
npm test -- tests/cli/reducer.test.ts tests/cli/app.test.tsx
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/cli/app.tsx tests/cli/app.test.tsx README.md CHANGELOG.md
git commit -m "feat: 单行显示工具调用"
```
