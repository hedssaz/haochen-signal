# 最终分支审查修复报告

## 状态与提交

- 状态：完成
- 实现提交：`8577cfedb86a9db720da19447e3570f81b3eadc3`
- 提交信息：`修复文件工具共享内部策略`

## Findings closure

### Important：目录排除规则保持单一事实源

- `EXCLUDED_DIRECTORIES` 只保留在 `src/tools/files/common.ts`。
- `common.ts` 新增内部 `isExcludedDirectory`，`hasExcludedDirectory` 复用该函数。
- `src/tools/files/read.ts` 的递归枚举也调用 `isExcludedDirectory`，不再维护第二份集合。
- 公共 facade 仍只导出原有 `hasExcludedDirectory`，未扩展公共 API。

### Minor 1：共享文本行解析器

- 新增 `src/tools/files/text-lines.ts`，集中保存 `TextLineState` 和
  `consumeTextLines`。
- `read.ts` 与 `search.ts` 均直接从该内部模块导入，不再复制实现。
- 原实现逐字迁移，CR、CRLF、LF、尾部换行及跨分块 CRLF 的运行语义不变。

### Minor 2：补足直接结构契约

- `tests/architecture/module-boundaries.test.ts` 新增两个范围受限的源码结构契约：
  - 目录排除集合归 `common.ts` 所有，递归枚举直接调用共享判断。
  - 行解析实现归 `text-lines.ts` 所有，`read.ts` 与 `search.ts` 直接导入。
- 未构建通用静态分析系统。
- `normalizeGitTool`、`normalizeWebTool` 的统一 policy context 参数断言原样保留。

## TDD：RED / GREEN

### RED

命令：

```text
npm test -- tests/architecture/module-boundaries.test.ts
```

结果：

- 退出码：1
- 8 项中 2 项按预期失败，原有 6 项通过。
- 失败原因分别是：
  - `common.ts` 尚无共享 `isExcludedDirectory`。
  - `text-lines.ts` 尚不存在。

### GREEN

同一命令在最小实现后重新执行：

- 退出码：0
- 1 个测试文件通过。
- 8 项测试全部通过。

## 完整验证

### 定向测试

```text
npm test -- tests/architecture/module-boundaries.test.ts tests/tools/files.test.ts tests/integration/agent-workflow.test.ts
```

- 退出码：0
- 3 个测试文件通过。
- 70 项测试通过。

### 类型检查

```text
npm run typecheck
```

- 退出码：0

### 完整测试

```text
npm test
```

- 退出码：0
- 42 个测试文件通过。
- 743 项测试通过。

### 构建

```text
npm run build
```

- 退出码：0

### 差异检查

```text
git diff --check
```

- 退出码：0
- 无输出。

## 内部文件行数

按模块化计划的三个内部目录检查，最大文件为
`src/tools/command/run-command.ts`，510 行；全部低于 600 行。

```text
510 src/tools/command/run-command.ts
487 src/security/boundary/command-policy.ts
350 src/tools/files/read.ts
344 src/tools/command/windows-process-tree.ts
322 src/security/boundary/network-policy.ts
289 src/security/boundary/common.ts
276 src/tools/files/patch-plan.ts
248 src/tools/files/patch-execute.ts
210 src/security/boundary/file-policy.ts
199 src/tools/files/common.ts
185 src/tools/files/patch-files.ts
138 src/tools/files/file-access.ts
129 src/tools/command/output-log.ts
118 src/security/boundary/classify.ts
116 src/tools/files/search.ts
108 src/security/boundary/command-targets.ts
101 src/security/boundary/other-tools.ts
92  src/tools/files/types.ts
84  src/tools/command/errors.ts
76  src/tools/files/patch.ts
73  src/tools/command/types.ts
53  src/tools/files/write.ts
39  src/tools/files/text-lines.ts
36  src/tools/command/process-controller.ts
15  src/security/boundary/types.ts
```

## 自检

- 目录排除集合仅有一个运行时定义。
- 行解析状态与消费函数仅有一个运行时定义。
- 共享解析器的两个消费者均由架构测试锁定直接导入关系。
- 公共 API、错误代码、用户可见文案、默认值与执行顺序未改动。
- 未修改 README 或 CHANGELOG。
- 未新增运行时依赖。
- 工作范围仅覆盖最终审查清单。

## 顾虑

无。
