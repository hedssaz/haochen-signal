# Task 10 实施报告

## 范围

- 新增 `src/agent/types.ts`：上下文输入、结构化摘要、压缩结果与总结器类型。
- 新增 `src/agent/context.ts`：固定 UTF-8 token 估算、按优先级选择上下文、单文件 25% 截断、结构化信号压缩与追加式摘要读取投影。
- 更新 `src/sessions/types.ts`：摘要事件以 `coveredEventCount` 声明其覆盖的 JSONL 前缀，保持旧摘要记录兼容。
- 新增 `tests/agent/context.test.ts`：预算、优先级、超大任务降级、文件二次截断、Zod 失败保留历史、最近 6 条事件与追加式会话持久化覆盖。

## TDD 记录

初始实现先新增上下文测试并执行 `npm test -- tests/agent/context.test.ts`；在实现前，测试因缺少 `src/agent/context.ts` 失败。复审修复继续遵循 TDD：先追加“摘要追加后的读取投影”“超大当前任务保留”“极小预算降级”和“文件剩余预算二次截断”测试，旧实现出现 5 项预期失败；再以最小改动补齐覆盖范围元数据与截断逻辑，聚焦测试转为通过。

## 关键约束

- `estimateTokens` 固定为 `Math.ceil(Buffer.byteLength(text, 'utf8') / 3)`。
- 当前任务会预留预算并作为最后一条用户消息发送；超长任务按可用预算保留首尾，若仅消息封装可容纳则降级为 `…`，连该封装也放不下时返回空上下文且绝不超限。装载优先级依次为系统提示、任务、未完成计划、最近 6 条事件、相关文件、历史摘要及更早事件。
- 相关文件先受总预算 25% 的上限约束；若上限内容仍装不下，会按已占用上下文的剩余预算再次截断，保留可容纳的首尾和省略标记。
- 压缩只在超过 6 条事件时执行；成功的 `summaryEvent` 记录 `coveredEventCount`，由 `SessionStore.append` 追加。`buildContext` 在读取时将该前缀替换为摘要并保留原最近 6 条事件，原始 JSONL 不会重写。
- 总结返回值经 Zod 严格校验；模型失败或结构无效时返回 `compacted: false` 且保留完整历史。
