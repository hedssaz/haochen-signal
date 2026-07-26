# Task 4 实施报告：usage 事件与底栏状态

## 范围

- 在代理循环中增加合法 `finish.usage` 到终端 `usage` 事件的转换。
- 在 CLI reducer 中保存最近真实上下文用量、当前完成轮次用量及工具阶段显示状态。
- 在常驻底栏显示 `↓ 分片数 · 阶段 · 上下文 used / max`，并在工具、审查、确认或上传阶段显示上一轮总量。
- 保持配置 Schema、凭据和模型管理界面不变。

## RED

先新增 5 个失败行为测试：

- 合法 usage 必须在任何工具执行前发出。
- usage 缺失或含负数、非整数时不得伪造 `usage` 事件。
- reducer 只保存一次 `inputTokens + outputTokens`，同轮多工具复用该值。
- 当前轮缺失 usage 时，上箭头必须显示未知，并在下一模型流隐藏。
- 底栏必须显示真实 `used / max`，不得用非空流分片数冒充上一轮真实 token。

首次聚焦运行结果：3 个测试文件中 5 个新增测试失败、81 个既有测试通过。失败原因均为功能尚未实现。

## GREEN

- `AgentEvent` 新增 `usage`；代理循环仅接受非负有限整数（整数检查同时排除 `NaN` 与无穷值），在唯一 finish 及结束原因协议通过后发出，并保证位于工具执行前。
- `UiState` 新增 `usedContext`、`roundUsageTotal`、`previousRoundTotal` 和阶段显示标志；新任务保留最近真实上下文，仅清除当前轮临时状态。
- 同一工具批次始终复用一个 `previousRoundTotal`；无 usage 的新轮会将其设为未知。
- 模型增量开始、工具结束或终态会隐藏上箭头；工具、审查和确认阶段显示上箭头。
- 常驻底栏继续按每个非空 reasoning/text delta 计 1 个 `↓ token`，真实 usage 只用于上下文和上箭头。

聚焦 GREEN：`npm test -- tests/agent/loop.test.ts tests/cli/reducer.test.ts tests/cli/app.test.tsx`，86/86 通过。

## 自审

- 事件顺序：usage 在唯一合法 finish 完整验证后、`tool_started` 及实际 registry 执行前。
- 缺失语义：最近已知真实 usage 继续用于常驻上下文；当前工具轮缺失 usage 时单独显示未知。
- 批次语义：多工具只读取同一轮总量，没有任何累加路径。
- 生命周期：下一模型增量和最终完成均隐藏上箭头；新任务不清除最近真实上下文。
- 范围控制：未修改配置 Schema、凭据解析、模型配置 UI 或供应商协议类型。

## 验证与已知基线

- 聚焦测试：86/86 通过。
- `npm run typecheck` 当前被既有配置 v2 迁移基线阻断：`src/cli/index.tsx`、`src/providers/openai-compatible.ts` 和 `tests/cli/first-run.test.ts` 仍引用已移除的旧配置字段，共 13 个错误；错误不涉及本任务修改文件。
- 提交：`feat: 显示真实上下文与工具轮用量`。
