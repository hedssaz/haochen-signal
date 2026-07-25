# 浩宸信号模型配置、上下文用量与安全写文件设计

## 背景

当前版本存在三组直接影响可用性的问题：

1. `/model` 只能临时替换当前模型字符串，首次启动却强制要求填写模型；无法保存多个供应商、获取模型列表或持久化切换；
2. 模型供应商已经在每轮 `finish.usage` 返回真实 `inputTokens` 和 `outputTokens`，终端却只显示用户指定的流分片计数，没有显示已用/最大上下文，也没有在工具阶段显示上一轮总 token；
3. 模型工具列表缺少 `write_file`。模型按常见编码工具习惯调用该名称时会被注册表拒绝，随后可能退回风险更高的 Shell/heredoc 写入。

本次把三组问题作为一个终端工作流完成：先在独立模型配置界面绑定供应商和模型，再以真实 usage 展示上下文，最后通过受边界保护的文件工具执行创建操作。

## 目标

- `/model` 进入独立终端模型配置界面；
- 支持多个供应商，每个供应商拥有独立 API 地址和凭据引用；
- 支持调用 OpenAI-compatible `GET /models` 获取模型并用方向键、Enter 添加；
- 新安装首次启动不再强制配置供应商、API Key 或模型；
- 未绑定模型时普通提问不发起网络请求，只给出可操作错误；
- 底栏显示本轮流分片计数、最近完成轮次的已用上下文和当前模型最大上下文；
- 工具调用、审批和上传阶段显示上一轮 `inputTokens + outputTokens`；
- 新增创建专用、原子且受工作区边界保护的 `write_file`；
- 兼容旧版单供应商、单模型配置，并保持 macOS、Linux、Windows 行为一致。

## 配置模型

配置文件升级为版本化结构：

```ts
interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  credentialRef: string;
  headers: Record<string, string>;
}

interface ModelProfile {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
}

interface HaochenConfig {
  version: 2;
  providers: ProviderProfile[];
  models: ModelProfile[];
  activeModelId?: string;
  timeoutMs: number;
}
```

- `ProviderProfile.id` 和 `ModelProfile.id` 是本地稳定 ID，不使用数组位置作为身份；
- `baseUrl` 继续只接受无内嵌凭据的 HTTP(S) 地址并去除末尾 `/`；
- `credentialRef` 只保存凭据引用，不保存 API Key；
- `headers` 允许保存不敏感的兼容服务 Header；认证 Header 继续禁止明文持久化；
- `contextWindow` 是该模型的最大上下文，必须是至少 8,000 的整数，新增模型默认 128,000；
- `activeModelId` 可省略，表示当前没有绑定模型。

### 旧配置迁移

旧配置：

```json
{
  "baseUrl": "https://api.example.com/v1",
  "model": "example-model",
  "reviewModel": "review-model",
  "headers": {},
  "timeoutMs": 60000,
  "contextWindow": 128000
}
```

加载时迁移为一个供应商和至少一个模型：

- 主模型成为当前模型；
- `reviewModel` 若与主模型不同则迁移为同供应商下的第二个模型，但不自动设为当前模型；
- 旧 API Key 解析方式继续作为该供应商的凭据来源；
- 迁移后的配置在首次实际修改模型设置时以新版结构原子保存，不在只读启动时擅自改写用户文件。

## 凭据模型

每个供应商拥有独立凭据引用。API Key 不写入普通配置文件：

- macOS：使用现有 Keychain 适配器，以供应商 ID 区分条目；
- Linux、Windows：支持当前进程隐藏输入及供应商专属环境变量；
- 环境变量名由稳定供应商 ID 生成并显示在配置界面；
- 新增供应商时输入的 Key 立即可用于当前进程和“获取模型”；
- 若凭据未持久化，下一次启动选择该供应商模型时再次隐藏询问；
- 日志、工具摘要、错误和会话记录继续执行凭据脱敏。

本轮不在 Linux/Windows 配置文件中保存明文 Key，也不引入带原生编译依赖的第三方钥匙串库。

## `/model` 独立界面

输入 `/model` 后隐藏普通输入区和命令建议，进入模型配置状态。主界面按供应商分组：

```text
╭─ 模型配置 ───────────────────────────────────╮
│ DeepSeek                                     │
│   ● DeepSeek V4 Pro       128k   当前         │
│   ○ DeepSeek Reasoner     128k                │
│                                              │
│ Anthropic                                    │
│   ○ Claude Opus           200k                │
│                                              │
│ A 添加供应商  E 编辑  D 删除  Enter 切换      │
│ Esc 返回                                     │
╰──────────────────────────────────────────────╯
```

键位：

- `↑/↓`：跨供应商移动模型选择；
- `Enter`：切换当前模型并持久化；
- `A`：进入添加供应商向导；
- `E`：编辑当前模型的显示名称和最大上下文；
- `D`：删除当前模型；供应商不再包含模型时可一并删除供应商元数据；
- `Esc`：返回普通会话。

没有模型时显示空状态和 `A 添加供应商`，不显示无效选择光标。

### 添加供应商向导

向导字段依次为：

1. 供应商显示名称；
2. API 地址；
3. API Key（隐藏输入）；
4. `[ 获取模型 ]`；
5. `[ 手动添加 Model ID ]`；
6. `取消`。

字段在提交前完成 trim、URL 和非空校验。聚焦 `[ 获取模型 ]` 后按 Enter：

```http
GET {baseUrl}/models
Accept: application/json
Authorization: Bearer {apiKey}
```

请求要求：

- 使用与模型请求相同的用户取消信号和 `timeoutMs` 空闲/请求期限；
- 最多读取 2 MiB JSON；
- 只接受对象响应中的 `data` 数组及非空字符串 `id`；
- 模型 ID 去重并按稳定字典序展示；
- 认证信息不进入错误文本；
- 非成功状态、无效 JSON、缺少 `data` 或空列表显示界面内错误，不退出 CLI；
- 接口不支持 `/models` 时允许选择“手动添加 Model ID”。

获取成功后进入模型选择界面：

```text
╭─ 选择要添加的模型 ───────────────────────────╮
│ › deepseek-chat                              │
│   deepseek-reasoner                          │
│                                              │
│ Enter 添加  ↑↓ 选择  Esc 返回                 │
╰──────────────────────────────────────────────╯
```

按 Enter 后进入模型详情：

- Model ID 只读展示；
- 显示名称默认等于 Model ID，可修改；
- 最大上下文默认 128,000，可修改；
- 保存后模型加入列表并设为当前模型。

### 无模型行为

- CLI 可以在没有供应商和模型的情况下正常启动；
- `/help`、`/model`、`/resume`、`/exit` 等本地命令仍可用；
- 普通问题在注册前台任务和写入用户会话事件之前检查当前模型；
- 未绑定时显示 `未绑定模型，请先使用 /model 配置并选择模型。`；
- 不创建 ModelClient 请求，不锁住输入，也不产生虚假的 interrupted 或 error 会话事件。

## 模型客户端选择

模型客户端不再在启动时绑定唯一 `baseUrl` 和 API Key。运行任务时：

1. 读取当前 `activeModelId`；
2. 找到对应模型和供应商；
3. 从内存、环境变量或 Keychain 解析该供应商凭据；
4. 构建或复用以供应商配置和凭据身份为键的 OpenAI-compatible 客户端；
5. 将实际 `modelId`、该模型 `contextWindow` 和供应商客户端传给代理循环。

切换模型不会更换会话 ID，但下一次模型请求使用新模型和新上下文上限。已在运行的任务不响应中途切换；模型配置界面只在没有前台任务时开放。

红眼审查默认复用当前模型与供应商。本轮不提供跨供应商独立审查模型 UI；旧 `reviewModel` 仅为迁移兼容，不阻塞主模型切换。

## usage、上下文和上传显示

供应商 `finish.usage` 已规范化为：

```ts
{
  inputTokens: number;
  outputTokens: number;
}
```

代理循环新增 usage 事件，并在验证唯一合法 `finish` 后、进入工具执行前发给终端：

```ts
{
  type: 'usage';
  inputTokens: number;
  outputTokens: number;
}
```

若供应商不返回 usage，则保留最近一次已知 usage；从未获得 usage 时显示 0，不自行估算真实 token。

定义：

```ts
usedContext = inputTokens + outputTokens;
previousRoundTotal = inputTokens + outputTokens;
```

常驻底栏：

```text
↓ 171 tokens · 思考中 · 上下文 12.4k / 128k
```

- `↓ 171 tokens` 继续表示当前任务非空推理/回答流分片数量，一次分片计 1；
- `上下文 12.4k` 使用最近完成模型轮的 `inputTokens + outputTokens`；
- `/ 128k` 使用当前模型配置的 `contextWindow`；
- 当前模型切换后最大上下文立即更新；
- 新任务只清零流分片计数，不清除最近已知真实 usage；
- 切到没有 usage 历史的新模型时已用上下文显示 0。

工具调用、审批、确认或明确上传阶段额外显示：

```text
↑ 12.4k tokens · 上一轮总量
```

- 数值严格使用上一轮 `inputTokens + outputTokens`；
- 同一模型轮调用多个工具时只显示同一个总量，不重复相加；
- 工具轮结束并进入下一次模型流后隐藏；
- 最终纯文本回答完成后不显示上箭头；
- usage 缺失时显示 `↑ -- tokens · 上一轮总量未知`，避免把流分片数冒充真实 token。

## `write_file` 工具

新增模型工具：

```ts
interface WriteFileInput {
  path: string;
  content: string;
}
```

语义严格限定为创建新文件：

- 目标必须位于真实工作区内；
- 父目录必须已存在且为真实目录；
- 任一路径组件或目标符号链接均拒绝；
- 目标已存在时返回 `FILE_EXISTS`，不得覆盖；
- 内容必须是字符串；
- 使用与 `apply_patch` 的 `add` 操作相同的同目录临时文件、同步、原子发布和清理语义；
- 成功结果返回路径、增加行数及写入字节数；
- UI 工具标题为 `工具 › write_file`，摘要为“创建文件”，参数只显示路径和内容长度，不显示完整文件正文。

实现复用文件层已有的原子新增逻辑，不通过 Shell、Python、heredoc 或重定向创建文件。修改和删除已有文件继续使用 `apply_patch`。

确定性边界为 `write_file` 建立独立规范化：

- 输入只接受 `path` 和 `content`；
- 新路径按工作区 `new` 模式解析；
- 单文件创建进入 AI 审查，不能被确定性直接放行；
- 审批范围绑定规范化路径和内容摘要，不把完整内容写入审计；
- 注册表、Zod Schema、模型 JSON Schema、边界分类和执行实现必须同时包含该工具。

## 错误与中止

- 模型列表请求可以用第一次 `Ctrl+C` 中止并返回配置界面，第二次 `Ctrl+C` 才退出 CLI；
- 获取模型失败保留已填写的供应商字段和临时 Key，允许重试或手动添加；
- 保存配置失败时不切换内存当前模型，显示真实脱敏错误；
- 删除当前模型后自动变为未绑定，不擅自选择其他模型；
- usage 数字必须是非负有限整数；无效 usage 当作缺失处理；
- `write_file` 审批拒绝、路径越界、文件已存在或原子发布失败均作为工具真实结果返回模型；
- 任意凭据相关异常先脱敏再进入终端。

## 测试与验收

### 配置和迁移

- 新配置允许零供应商、零模型和无当前模型；
- 旧配置迁移为稳定供应商和模型；
- 无效 activeModelId、重复 ID、空 Model ID 和过小上下文被拒绝或规范化；
- 多供应商配置保存后可无损加载；
- 凭据不出现在配置 JSON。

### 模型配置界面

- `/model` 进入独立界面，Esc 返回；
- 空状态、分组列表、当前模型标记和键盘导航正确；
- 添加供应商字段校验和 Key 隐藏输入正确；
- Enter 调用 `/models`，解析、去重、排序并显示模型；
- Enter 添加模型并持久化，切换后最大上下文更新；
- `/models` 失败后可重试或手动添加；
- 未绑定模型时普通问题不调用 runTask。

### usage 和底栏

- 代理循环把唯一 finish usage 转成 usage 事件；
- `inputTokens + outputTokens` 用于已用上下文和上箭头；
- 流分片计数继续独立累计；
- 工具、审批和确认阶段显示上箭头，下一模型轮隐藏；
- usage 缺失显示未知，不伪造；
- 多工具调用不重复累计；
- 模型切换更新最大上下文并隔离各模型最近 usage。

### `write_file`

- 创建 UTF-8 新文件成功；
- 已存在目标拒绝且内容不变；
- 路径越界、符号链接父路径和符号链接目标拒绝；
- 取消、写入失败、同步失败和发布失败不留下可见残缺文件；
- 模型 Schema、注册表、确定性边界、工具摘要和审计范围一致；
- 工具摘要不泄露正文。

### 全量交付

- `npm test`、`npm run typecheck`、`npm run build` 全部通过；
- 标准入口和单文件入口行为一致；
- 本机全局安装包包含最新配置界面和工具；
- macOS、Linux、Windows Node 20 CI 全部通过；
- 中文 README 与 CHANGELOG 同步更新；
- 最终代码审查无 Critical 或 Important。

## 非目标

- 本轮不实现同时登录多个账号或 OAuth；
- 本轮不在 Linux/Windows 明文保存 API Key；
- 本轮不自动猜测模型上下文上限；
- 本轮不支持运行中热切换当前模型；
- 本轮不把 `write_file` 扩展为覆盖已有文件；
- 本轮不把真实 tokenizer usage 与用户指定的流分片计数混为一谈。
