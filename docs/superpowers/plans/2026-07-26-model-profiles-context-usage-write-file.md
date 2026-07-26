# 多模型配置、上下文用量与写文件工具实施计划

> 设计依据：`docs/superpowers/specs/2026-07-26-model-profiles-context-usage-write-file-design.md`

## 目标

一次完成并交付：

- `write_file` 成为正式的“仅新建”工具；
- `/model` 打开独立的多供应商、多模型配置界面；
- 新安装允许无模型启动，未绑定模型时明确报错；
- 供应商模型列表可通过 `GET /models` 获取并用 Enter 添加；
- 底栏显示流分片数、真实已用上下文、最大上下文；
- 工具阶段显示上一轮真实 `inputTokens + outputTokens`。

## Task 1：配置 v2 与旧配置迁移

**文件**

- 修改：`src/config/schema.ts`、`src/config/load.ts`
- 测试：`tests/config/load.test.ts`

**步骤**

- [ ] 先新增失败测试，覆盖空 v2 配置、多个供应商/模型、非法 URL、稳定旧配置迁移、保存时不含密钥。
- [ ] 定义 `ProviderProfile`、`ModelProfile`、`HaochenConfig` v2。
- [ ] 让 `parseConfig` 同时接受旧结构并迁移到 v2。
- [ ] 运行 `npx vitest run tests/config/load.test.ts`。
- [ ] 提交：`feat: 升级多模型配置结构`

## Task 2：供应商凭据与模型发现

**文件**

- 修改：`src/config/credentials.ts`、`src/cli/startup-credentials.ts`
- 新增：`src/providers/model-discovery.ts`
- 测试：`tests/config/credentials.test.ts`、`tests/cli/startup-credentials.test.ts`
- 新增测试：`tests/providers/model-discovery.test.ts`

**步骤**

- [ ] 先新增失败测试，覆盖供应商专属环境变量、macOS Keychain 服务项、隐藏临时输入。
- [ ] 新增 `discoverModels`，限制 2 MiB、校验 `data[].id`、去重排序。
- [ ] 保证错误和日志不包含 API Key。
- [ ] 运行聚焦测试并提交：`feat: 支持供应商凭据与模型发现`

## Task 3：正式 `write_file` 工具

**文件**

- 修改：`src/tools/files.ts`、`src/cli/index.tsx`、`src/security/boundary.ts`
- 修改：`src/cli/reducer.ts`、`src/cli/tool-summary.ts`、`src/agent/prompts.ts`
- 测试：`tests/tools/files.test.ts`、`tests/security/boundary.test.ts`
- 测试：`tests/cli/tool-summary.test.ts`、`tests/tools/registry.test.ts`

**步骤**

- [ ] 先新增失败测试，证明工具已注册、可原子新建、拒绝覆盖、拒绝越界和符号链接逃逸。
- [ ] 复用 `apply_patch` 的 `add` 原子写入路径实现 `writeFile`。
- [ ] 将 `write_file` 加入变更类边界审查；摘要只显示路径和字符数。
- [ ] 更新系统提示：新文件用 `write_file`，已有文件用 `apply_patch`。
- [ ] 运行聚焦测试并提交：`feat: 新增安全写文件工具`

## Task 4：usage 事件与底栏状态

**文件**

- 修改：`src/agent/loop.ts`、`src/cli/reducer.ts`、`src/cli/app.tsx`
- 测试：`tests/agent/loop.test.ts`、`tests/cli/reducer.test.ts`、`tests/cli/app.test.tsx`

**步骤**

- [ ] 先新增失败测试，覆盖 usage 在工具执行前发出、缺失 usage、同轮多工具不重复累计。
- [ ] 增加 `usage` 事件并保存最近完成轮次的 `input + output`。
- [ ] 常驻显示 `↓ … · 上下文 used / max`；工具/审批阶段显示 `↑ … · 上一轮总量`。
- [ ] 保持“每个非空流 delta 算一个 token”的现有用户约定。
- [ ] 运行聚焦测试并提交：`feat: 显示真实上下文与工具轮用量`

## Task 5：`/model` 独立配置界面

**文件**

- 新增：`src/cli/model-config.ts`、`src/cli/model-config-view.tsx`
- 修改：`src/cli/app.tsx`、`src/cli/commands.ts`、`src/cli/index.tsx`
- 新增测试：`tests/cli/model-config.test.ts`、`tests/cli/model-config-view.test.tsx`
- 修改测试：`tests/cli/app.test.tsx`、`tests/cli/commands.test.ts`

**步骤**

- [ ] 先写纯状态机测试：方向键、Enter 切换、A/E/D/Esc、向导字段、隐藏 Key、发现列表、手动 Model ID。
- [ ] 实现独立全屏 Ink 面板及无模型空状态。
- [ ] 保存供应商/模型时原子写配置；macOS 保存供应商专属 Keychain，其他平台仅保留进程内 Key。
- [ ] 切换模型立即更新最大上下文，并按模型 ID 隔离最近 usage。
- [ ] 运行聚焦测试并提交：`feat: 新增独立模型配置界面`

## Task 6：无模型启动与动态模型客户端

**文件**

- 修改：`src/cli/index.tsx`、`src/cli/first-run.ts`、`src/cli/startup-credentials.ts`
- 修改：`src/security/reviewer.ts`
- 测试：`tests/cli/index.test.ts`、`tests/cli/first-run.test.ts`
- 测试：`tests/cli/startup-credentials.test.ts`、`tests/integration/agent-workflow.test.ts`

**步骤**

- [ ] 先写失败测试：无配置正常启动、无当前模型提问不联网、切换供应商后下一轮使用对应客户端。
- [ ] 启动时创建空 v2 配置，不再强制首屏询问模型。
- [ ] 每次任务开始解析当前模型、供应商和凭据，动态构建客户端。
- [ ] 红眼审查默认复用当前模型。
- [ ] 运行聚焦测试并提交：`feat: 支持无模型启动和动态客户端`

## Task 7：文档、完整验证和交付

**文件**

- 修改：`README.md`、`CHANGELOG.md`

**步骤**

- [ ] 中文记录 `/model`、多供应商、Key 存储差异、上下文/上箭头语义和 `write_file`。
- [ ] 运行 `npm test`、`npm run typecheck`、`npm run build`、`git diff --check`。
- [ ] 执行独立代码审查并修复所有 Critical/Important 问题。
- [ ] 打包并全局安装本机版本。
- [ ] 做无模型启动、`/model`、模型切换、`write_file` 注册的终端冒烟测试。
- [ ] 提交文档，推送 `main`，等待 GitHub 三平台 CI 结束。

