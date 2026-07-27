# 超长源文件模块化设计

## 目标

在不改变公共 API、工具行为、安全策略和用户可见文案的前提下，拆分三个超过 1000 行的正式源代码文件：

- `src/tools/files.ts`
- `src/tools/command.ts`
- `src/security/boundary.ts`

拆分后保留原路径作为稳定入口，现有调用方无需修改导入路径。新文件按职责组织，单个核心实现文件原则上控制在 600 行以内。

## 方案选择

采用“兼容门面 + 内部模块”方案：

1. 原文件保留公共类型、公共函数的重新导出或薄封装。
2. 具体实现迁入同名子目录。
3. 不新增依赖，不调整功能，不顺手修改策略或错误文案。
4. 每个超长文件单独拆分、验证并提交。

未采用以下方案：

- 直接修改所有调用方导入路径：改动面过大，无法提供稳定入口。
- 仅按行数机械切割：会产生职责不清、循环依赖和共享状态泄漏。

## 文件工具边界

`src/tools/files.ts` 保留兼容导出，内部拆为：

- `src/tools/files/types.ts`：输入、输出、补丁计划和文件操作接口。
- `src/tools/files/common.ts`：工具结果、错误、路径比较、摘要和通用校验。
- `src/tools/files/read.ts`：安全打开、文件读取、目录枚举和文本解码。
- `src/tools/files/search.ts`：文本搜索、预览和匹配限制。
- `src/tools/files/patch.ts`：补丁验证、并发状态检查、临时文件发布和删除。
- `src/tools/files/write.ts`：`writeFile` 对补丁接口的兼容封装。

公共入口继续提供 `listFiles`、`searchText`、`readFileTool`、`applyPatch`、`writeFile` 以及现有公共类型。

## 命令工具边界

`src/tools/command.ts` 保留兼容导出，内部拆为：

- `src/tools/command/types.ts`：运行输入、输出和运行时注入接口。
- `src/tools/command/errors.ts`：输入校验和工具错误结果。
- `src/tools/command/process-controller.ts`：POSIX 进程组控制和通用进程控制接口。
- `src/tools/command/windows-process-tree.ts`：Windows 进程快照、身份匹配和树终止。
- `src/tools/command/output-log.ts`：超限输出日志创建、关闭、清理和脱敏。
- `src/tools/command/run-command.ts`：命令启动、流式收集、超时、中止和最终结果编排。

公共入口继续提供 `runCommand`、`createWindowsProcessController`、`executableSearchCandidates` 以及现有公共类型。

## 安全边界模块

`src/security/boundary.ts` 保留 `classifyOperation` 和现有类型导出，内部拆为：

- `src/security/boundary/types.ts`：内部规范化结果和 JSON 类型。
- `src/security/boundary/common.ts`：严格输入解析、指纹、决策和通用校验。
- `src/security/boundary/command-policy.ts`：命令解包、风险原因、路径目标和依赖安装判断。
- `src/security/boundary/network-policy.ts`：URL、IP、curl 参数和网络覆盖规则。
- `src/security/boundary/file-policy.ts`：文件、补丁和写文件输入规范化。
- `src/security/boundary/other-tools.ts`：Git、搜索和网页工具规范化。
- `src/security/boundary/classify.ts`：工具分派和最终决策。

内部模块只导出相邻模块需要的最小接口，避免形成新的“公共内部 API”。安全判断的顺序、原因文本、风险等级和指纹输入保持不变。

## 数据流与兼容性

调用方仍从原路径导入。原入口将输入交给内部模块，内部模块返回与拆分前相同的 `ToolResult` 或 `BoundaryDecision`。类型导出名称、可选字段、默认值和错误代码均保持不变。

不改变：

- `list_files` 的 500 文件上限和浅层优先策略。
- 文件读写的符号链接、竞态和原子发布防护。
- 命令超时、输出截断、日志脱敏和进程树清理。
- 审批边界的确定性判断、AI 审查原因和用户确认原因。

## 测试策略

这是行为不变重构，现有测试是主要契约。每个阶段先增加一个“兼容入口仍可导入并工作”的结构测试，让测试因目标内部模块尚不存在而失败，再迁移最小实现使其通过。

每个阶段运行：

1. 对应单元测试。
2. 相关集成测试。
3. TypeScript 类型检查。

全部拆分后运行：

- `npm test`
- `npm run typecheck`
- `npm run build`
- `git diff --check`

## 提交策略

按以下顺序形成独立提交：

1. 设计与实施计划。
2. 拆分文件工具。
3. 拆分命令工具。
4. 拆分安全边界。
5. 更新中文 `README.md` 和 `CHANGELOG.md`。

任何阶段出现行为回归、循环依赖或安全测试失败时立即停止，不继续下一阶段。
