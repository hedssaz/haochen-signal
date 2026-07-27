# 超长源文件模块化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在公共 API 和运行行为不变的前提下，将 `files.ts`、`command.ts`、`boundary.ts` 拆成职责单一的内部模块。

**Architecture:** 原文件继续作为兼容门面，现有调用方保持原导入路径；实现代码迁入同名子目录。每个阶段先增加结构契约测试并观察缺少目标模块的预期失败，再迁移原实现、运行相关回归并独立提交。

**Tech Stack:** TypeScript、Node.js、Vitest、ES Modules、esbuild

## Global Constraints

- 不改变任何公共导出名称、参数、返回值、错误代码或用户可见文案。
- 不改变文件安全、命令清理和审批边界的判断顺序及默认值。
- 不新增运行时依赖。
- 原入口文件必须保留，现有调用方不改导入路径。
- 每个内部核心实现文件原则上不超过 600 行；纯类型和兼容门面不计入该目标。
- 每完成一个原文件拆分就运行相关测试、类型检查并独立提交。
- README 和 CHANGELOG 使用中文。

---

### Task 1: 拆分文件工具

**Files:**
- Create: `src/tools/files/types.ts`
- Create: `src/tools/files/common.ts`
- Create: `src/tools/files/read.ts`
- Create: `src/tools/files/search.ts`
- Create: `src/tools/files/patch.ts`
- Create: `src/tools/files/write.ts`
- Modify: `src/tools/files.ts`
- Create: `tests/architecture/module-boundaries.test.ts`
- Test: `tests/tools/files.test.ts`
- Test: `tests/integration/agent-workflow.test.ts`

**Interfaces:**
- Consumes: `ToolContext`, `ToolResult`, `ResolvedPath` 和现有路径边界、脱敏函数。
- Produces: 原入口继续导出 `listFiles`、`searchText`、`readFileTool`、`applyPatch`、`writeFile`、`hasExcludedDirectory` 及全部现有公共类型。
- Internal: `read.ts` 导出 `listFiles`、`readFileTool`、`readSearchFile`；`search.ts` 导出 `searchText`；`patch.ts` 导出 `applyPatch`；`write.ts` 导出 `writeFile`。

- [ ] **Step 1: 写入文件工具结构契约测试**

在 `tests/architecture/module-boundaries.test.ts` 添加：

```ts
import {describe, expect, it} from 'vitest';
import * as filesFacade from '../../src/tools/files.js';
import {
  listFiles,
  readFileTool,
} from '../../src/tools/files/read.js';
import {searchText} from '../../src/tools/files/search.js';
import {applyPatch} from '../../src/tools/files/patch.js';
import {writeFile} from '../../src/tools/files/write.js';

describe('tool module boundaries', () => {
  it('keeps the file tool facade compatible', () => {
    expect(filesFacade.listFiles).toBe(listFiles);
    expect(filesFacade.readFileTool).toBe(readFileTool);
    expect(filesFacade.searchText).toBe(searchText);
    expect(filesFacade.applyPatch).toBe(applyPatch);
    expect(filesFacade.writeFile).toBe(writeFile);
  });
});
```

- [ ] **Step 2: 运行结构测试并确认红灯**

Run:

```bash
npm test -- tests/architecture/module-boundaries.test.ts
```

Expected: FAIL，TypeScript/Vite 报告 `src/tools/files/read.js` 等目标模块不存在。

- [ ] **Step 3: 迁移公共类型与通用能力**

将现有声明按原名称迁入 `types.ts`：

```ts
export interface ListFilesInput { path?: string }
export interface ListFilesOutput { files: string[] }
export interface SearchTextInput { query: string; path?: string; maxMatches?: number }
export interface SearchMatch { path: string; line: number; column: number; preview: string }
export interface SearchTextOutput { matches: SearchMatch[] }
export interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
  startCharacter?: number;
  maxCharacters?: number;
}
export interface ReadFileOutput {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  startCharacter: number;
  endCharacter: number;
  totalCharacters: number;
  nextCharacter?: number;
}
export type PatchOperation =
  | {type: 'add'; path: string; content: string}
  | {type: 'update'; path: string; expected: string; replacement: string}
  | {type: 'delete'; path: string; sha256: string};
export interface ApplyPatchInput { operations: PatchOperation[] }
export interface WriteFileInput { path: string; content: string }
export interface WriteFileOutput {
  path: string;
  additions: number;
  bytesWritten: number;
  warnings?: string[];
}
export interface FileChange {
  path: string;
  type: PatchOperation['type'];
  additions: number;
  deletions: number;
}
export interface ApplyPatchOutput {
  changes: FileChange[];
  warnings?: string[];
}
type OpenFileHandle = Awaited<ReturnType<typeof open>>;
export interface PatchFileOperations {
  write(file: OpenFileHandle, contents: Buffer): Promise<void>;
  truncate(file: OpenFileHandle, length: number): Promise<void>;
  sync(file: OpenFileHandle): Promise<void>;
  chmod(file: OpenFileHandle, mode: number): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  close(file: OpenFileHandle): Promise<void>;
}
```

将 `FileToolError`、`success`、`failure`、`assertNotAborted`、`toWorkspacePath`、`hasExcludedDirectory`、`comparePaths`、`fileIdentity`、`sameIdentity`、`sha256`、`countLines`、`assertString` 迁入 `common.ts`。同时迁移 `safeProperty`、`safeRedactedMessage`、`postCommitWarning` 和相关常量；不得改函数参数、函数体或文案。内部导出清单固定为：

```ts
export {
  FileToolError,
  assertNotAborted,
  assertString,
  comparePaths,
  countLines,
  failure,
  fileIdentity,
  hasExcludedDirectory,
  postCommitWarning,
  safeProperty,
  safeRedactedMessage,
  sameIdentity,
  sha256,
  success,
  toWorkspacePath,
};
```

- [ ] **Step 4: 迁移目录枚举、读取与搜索**

将 `collectRegularFiles` 至 `readFileTool` 的读取相关实现迁入 `read.ts`，其中 `readSearchFile` 作为内部导出供搜索模块使用。将 `searchPreview`、搜索输入校验及 `searchText` 迁入 `search.ts`。

依赖方向固定为：

```text
types.ts <- common.ts
types.ts + common.ts <- read.ts
types.ts + common.ts + read.ts <- search.ts
```

不得把补丁写入逻辑反向导入读取模块。

- [ ] **Step 5: 迁移补丁和写文件实现**

将 `countOccurrences` 至 `applyPatch` 迁入 `patch.ts`，包括默认文件操作、补丁计划类型、临时文件、并发状态检查和原子发布逻辑。将 `writeFile` 迁入 `write.ts`，只通过 `applyPatch` 创建 `add` 操作：

```ts
const result = await applyPatch({
  operations: [{
    type: 'add',
    path: input.path,
    content: input.content,
  }],
}, context, signal, fileOperationOverrides);
```

保持原有错误转换、警告和 `truncated` 字段透传。

- [ ] **Step 6: 将原文件改为兼容门面**

`src/tools/files.ts` 最终只保留重新导出：

```ts
export {hasExcludedDirectory} from './files/common.js';
export {listFiles, readFileTool} from './files/read.js';
export {searchText} from './files/search.js';
export {applyPatch} from './files/patch.js';
export {writeFile} from './files/write.js';
export type {
  ApplyPatchInput,
  ApplyPatchOutput,
  FileChange,
  ListFilesInput,
  ListFilesOutput,
  PatchFileOperations,
  PatchOperation,
  ReadFileInput,
  ReadFileOutput,
  SearchMatch,
  SearchTextInput,
  SearchTextOutput,
  WriteFileInput,
  WriteFileOutput,
} from './files/types.js';
```

- [ ] **Step 7: 运行文件工具验证并确认绿灯**

Run:

```bash
npm test -- tests/architecture/module-boundaries.test.ts tests/tools/files.test.ts tests/integration/agent-workflow.test.ts
npm run typecheck
```

Expected: 相关测试全部 PASS，类型检查退出码 0。

- [ ] **Step 8: 提交文件工具拆分**

```bash
git add src/tools/files.ts src/tools/files tests/architecture/module-boundaries.test.ts
git commit -m "refactor: 拆分文件工具模块"
```

---

### Task 2: 拆分命令工具

**Files:**
- Create: `src/tools/command/types.ts`
- Create: `src/tools/command/errors.ts`
- Create: `src/tools/command/process-controller.ts`
- Create: `src/tools/command/windows-process-tree.ts`
- Create: `src/tools/command/output-log.ts`
- Create: `src/tools/command/run-command.ts`
- Modify: `src/tools/command.ts`
- Modify: `tests/architecture/module-boundaries.test.ts`
- Test: `tests/tools/command.test.ts`
- Test: `tests/integration/agent-workflow.test.ts`

**Interfaces:**
- Produces: 原入口继续导出 `runCommand`、`createWindowsProcessController`、`executableSearchCandidates` 及全部现有公共类型。
- Internal: `run-command.ts` 导出 `runCommand`；`windows-process-tree.ts` 导出 `createWindowsProcessController` 和默认 Windows 控制器；`output-log.ts` 提供日志关闭、脱敏和清理函数。

- [ ] **Step 1: 增加命令工具结构契约测试**

在现有结构测试中追加：

```ts
import * as commandFacade from '../../src/tools/command.js';
import {runCommand} from '../../src/tools/command/run-command.js';
import {
  createWindowsProcessController,
} from '../../src/tools/command/windows-process-tree.js';

it('keeps the command tool facade compatible', () => {
  expect(commandFacade.runCommand).toBe(runCommand);
  expect(commandFacade.createWindowsProcessController)
    .toBe(createWindowsProcessController);
});
```

- [ ] **Step 2: 运行结构测试并确认红灯**

Run:

```bash
npm test -- tests/architecture/module-boundaries.test.ts
```

Expected: FAIL，报告命令内部模块不存在。

- [ ] **Step 3: 迁移类型、错误和进程控制**

将现有公共接口及内部结果类型迁入 `types.ts`。将 `CommandToolError`、`invalidInput`、`validateInput`、`failure`、`inputFailure` 迁入 `errors.ts`。

将 `signalPosixProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void`、`processGroupExists(child: ChildProcess): boolean`、`waitForProcessGroupExit(child: ChildProcess): Promise<void>` 迁入 `process-controller.ts`。三个函数均导出供 `run-command.ts` 使用，函数体、延时和信号选择保持逐行不变。

- [ ] **Step 4: 迁移 Windows 进程树**

将 `WINDOWS_TREE_WAIT_TIMEOUT_MS` 至 `createWindowsProcessController` 迁入 `windows-process-tree.ts`，包含进程快照脚本、进程身份匹配、存活进程计算和 `taskkill` 调用。

导出：

```ts
export function createWindowsProcessController(
  runner: WindowsProcessRunner,
): ProcessController;

export const WINDOWS_PROCESS_CONTROLLER: ProcessController;
```

- [ ] **Step 5: 迁移输出日志和主执行流程**

将 `decode`、`ensureOutputLogClosed`、`sanitizeOutputLogFile`、`cleanupOutputLogFile`、`outputLogCleanupData` 迁入 `output-log.ts`。将 `runCommand` 及其只服务于单次执行的局部辅助逻辑迁入 `run-command.ts`。

`run-command.ts` 只从相邻模块导入：

```ts
import type {RunCommandInput, RunCommandRuntimeOptions} from './types.js';
import {validateInput, inputFailure, failure} from './errors.js';
import {WINDOWS_PROCESS_CONTROLLER} from './windows-process-tree.js';
import {
  cleanupOutputLogFile,
  decode,
  ensureOutputLogClosed,
  outputLogCleanupData,
  sanitizeOutputLogFile,
} from './output-log.js';
```

- [ ] **Step 6: 将原文件改为兼容门面**

```ts
export {executableSearchCandidates} from '../security/executable-identity.js';
export {runCommand} from './command/run-command.js';
export {
  createWindowsProcessController,
} from './command/windows-process-tree.js';
export type {
  CommandOutput,
  CommandTimerController,
  ProcessController,
  RunCommandInput,
  RunCommandRuntimeOptions,
  WindowsProcessRecord,
  WindowsProcessRunner,
  WindowsTaskkillResult,
} from './command/types.js';
```

- [ ] **Step 7: 运行命令工具验证并确认绿灯**

Run:

```bash
npm test -- tests/architecture/module-boundaries.test.ts tests/tools/command.test.ts tests/integration/agent-workflow.test.ts
npm run typecheck
```

Expected: 相关测试全部 PASS，类型检查退出码 0。

- [ ] **Step 8: 提交命令工具拆分**

```bash
git add src/tools/command.ts src/tools/command tests/architecture/module-boundaries.test.ts
git commit -m "refactor: 拆分命令工具模块"
```

---

### Task 3: 拆分安全边界

**Files:**
- Create: `src/security/boundary/types.ts`
- Create: `src/security/boundary/common.ts`
- Create: `src/security/boundary/network-policy.ts`
- Create: `src/security/boundary/command-policy.ts`
- Create: `src/security/boundary/file-policy.ts`
- Create: `src/security/boundary/other-tools.ts`
- Create: `src/security/boundary/classify.ts`
- Modify: `src/security/boundary.ts`
- Modify: `tests/architecture/module-boundaries.test.ts`
- Test: `tests/security/boundary.test.ts`
- Test: `tests/integration/agent-workflow.test.ts`

**Interfaces:**
- Produces: 原入口继续导出 `classifyOperation` 及 `BoundaryAction`、`BoundaryContext`、`BoundaryDecision`、`BoundaryOperation`、`BoundaryRisk`。
- Internal: 各 policy 模块接受未规范化输入与 `BoundaryContext`，返回统一 `NormalizedOperation`。

- [ ] **Step 1: 增加安全边界结构契约测试**

追加：

```ts
import * as boundaryFacade from '../../src/security/boundary.js';
import {
  classifyOperation,
} from '../../src/security/boundary/classify.js';

it('keeps the security boundary facade compatible', () => {
  expect(boundaryFacade.classifyOperation).toBe(classifyOperation);
});
```

- [ ] **Step 2: 运行结构测试并确认红灯**

Run:

```bash
npm test -- tests/architecture/module-boundaries.test.ts
```

Expected: FAIL，报告 `boundary/classify.js` 不存在。

- [ ] **Step 3: 迁移内部类型和通用规范化能力**

`types.ts` 定义并导出原内部类型：

```ts
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | {[key: string]: JsonValue};
export type JsonObject = {[key: string]: JsonValue};
export interface NormalizedOperation {
  input: JsonObject;
  scope: string[];
  confirmReasons: string[];
  reviewReasons: string[];
  allowReason: string;
  executableIdentity?: string;
}
```

将 `BoundaryInputError`、严格字段读取、稳定 JSON、指纹、决策构造、路径规范化和通用辅助函数迁入 `common.ts`。只导出 policy 模块实际使用的成员。

- [ ] **Step 4: 迁移网络和命令策略**

`network-policy.ts` 接收 curl 参数或 URL，保留以下原能力：

- curl 参数集合展开。
- 文件目标和网络覆盖提取。
- IPv4、IPv6 和主机名公网判断。
- `normalizePublicUrl`。

`command-policy.ts` 迁移命令白名单、shell 解包、依赖安装判断、确认/审查原因、命令目标规范化和 `normalizeCommand`。依赖方向只能是：

```text
types/common <- network-policy <- command-policy
```

禁止 `network-policy.ts` 反向导入命令策略。

- [ ] **Step 5: 迁移文件和其他工具策略**

`file-policy.ts` 迁移 `normalizeFileTool`、`normalizePatch` 和 `normalizeWriteFile`。`other-tools.ts` 迁移 `normalizeGitTool`、`normalizeWebTool` 和网页搜索限制常量的使用。

所有 scope 顺序、默认限制、确认原因、审查原因和 allow 文案保持逐字一致。

- [ ] **Step 6: 迁移最终分派并保留兼容门面**

`classify.ts` 包含 `KNOWN_TOOLS`、`normalizeOperation` 和 `classifyOperation`。原 `boundary.ts` 改为：

```ts
export {classifyOperation} from './boundary/classify.js';
export type {
  BoundaryAction,
  BoundaryContext,
  BoundaryDecision,
  BoundaryOperation,
  BoundaryRisk,
} from './types.js';
```

- [ ] **Step 7: 运行安全边界验证并确认绿灯**

Run:

```bash
npm test -- tests/architecture/module-boundaries.test.ts tests/security/boundary.test.ts tests/integration/agent-workflow.test.ts tests/agent/loop.test.ts tests/tools/registry.test.ts
npm run typecheck
```

Expected: 相关测试全部 PASS，类型检查退出码 0；不得更新安全断言来迁就实现。

- [ ] **Step 8: 提交安全边界拆分**

```bash
git add src/security/boundary.ts src/security/boundary tests/architecture/module-boundaries.test.ts
git commit -m "refactor: 拆分工具安全边界"
```

---

### Task 4: 更新文档并完成全量验证

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: 中文维护说明和可追踪的重构记录。

- [ ] **Step 1: 更新中文文档**

在 README 的项目结构或开发说明中记录三个兼容门面及其内部目录；在 CHANGELOG 的“修复”或“变更”段添加：

```markdown
- 将文件工具、命令工具和安全边界拆为职责单一的内部模块，保留原导入路径和运行行为。
```

- [ ] **Step 2: 检查文件规模**

Run:

```bash
wc -l src/tools/files.ts src/tools/files/*.ts src/tools/command.ts src/tools/command/*.ts src/security/boundary.ts src/security/boundary/*.ts
```

Expected: 三个兼容门面显著低于 100 行；核心实现文件原则上不超过 600 行。若个别文件因不可分割的状态机略超出，必须在提交说明中列出原因。

- [ ] **Step 3: 运行完整验证**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 全部测试 PASS，类型检查、构建和差异检查退出码均为 0。

- [ ] **Step 4: 提交文档**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: 记录核心模块拆分"
```

- [ ] **Step 5: 检查最终提交与工作区**

Run:

```bash
git status --short --branch
git log --oneline --decorate -6
```

Expected: 工作区干净，功能分支包含文件工具、命令工具、安全边界和文档四个独立提交。
