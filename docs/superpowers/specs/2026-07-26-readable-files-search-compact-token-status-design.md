# 浩宸信号可续读文件、联网搜索与任务状态设计

## 背景

当前终端在真实项目中暴露出四个相互关联的问题：

1. `read_file` 把 64 KiB I/O 分块大小误用为逻辑单行上限，压缩成单行的 HTML 即使未超过 2 MiB 文件上限也会直接失败；
2. `web_search` 的模型参数协议和工具实现允许 `limit`，确定性边界却拒绝该字段；
3. `/compact` 没有进入统一前台操作状态，压缩时无进度提示、输入未锁定且无法用第一次 `Ctrl+C` 正确中止；
4. OpenAI-compatible 流可能分别返回 `reasoning_content` 和 `content`，当前适配器只解析后者，也没有按流增量更新终端计数和思考阶段。

本次只修复这些直接影响可用性的缺陷，不扩大工具权限，也不取消现有的文件、网络或上下文安全总量限制。

## 目标

- 让不超过 2 MiB 的 UTF-8 单行文件能够通过 `read_file` 分页读取；
- 让模型声明、Zod 校验、确定性边界和 `web_search` 实现共享一致的 `limit` 语义；
- 让 `/compact` 与普通代理任务一样显示运行状态、锁定输入并支持中止；
- 把模型的思考流与最终回答流分区显示，并在底部持续显示 `↓ token 数量 · 思考中/正在回答/思考完成`；
- 保持 macOS、Linux、Windows 行为一致，并保持标准版和单文件版功能一致。

## 方案选择

### 文件读取

不直接删除读取上限，也不要求模型回退到 Shell 命令。`read_file` 保留 2 MiB 文件总上限和 400 行选择上限，同时增加选中内容内的字符分页：

```json
{
  "path": "game.html",
  "startLine": 1,
  "endLine": 1,
  "startCharacter": 65536,
  "maxCharacters": 65536
}
```

- `startCharacter` 是经统一换行处理后的所选行内容中的 Unicode 字符偏移，默认 `0`；
- `maxCharacters` 是本次最多返回的 Unicode 字符数，范围 `1..65536`，默认 `65536`；
- 调用方续读时必须保持相同的 `path/startLine/endLine`，并把上次返回的 `nextCharacter` 作为新 `startCharacter`；
- 输出增加 `startCharacter`、`endCharacter`、`totalCharacters` 和可选的 `nextCharacter`；
- 默认行模式遇到超长单行时返回第一块成功结果，而不是 `READ_LIMIT_EXCEEDED`；
- 文件总大小超过 2 MiB、无效 UTF-8、二进制文件、越界路径和无效分页参数仍被拒绝。

工具描述会明确告知模型续读方法。字符按 Unicode 码点计数，分页不能拆开 emoji 或其他代理对。

### 联网搜索

`web_search` 的唯一协议为：

```json
{"query": "检索内容", "limit": 5}
```

- `query` 去除首尾空白后长度为 `1..500`；
- `limit` 可省略，默认 `10`，范围 `1..10`；
- Zod、JSON Schema、确定性边界和工具实现使用同一范围；
- 规范化输入和审批指纹包含实际 `limit`，不同结果数量不会复用同一许可身份；
- 搜索仍只访问公开网络，现有 DNS 固定、SSRF、超时和响应上限不变。

### `/compact` 前台操作

终端维护唯一的前台操作：

```ts
type ForegroundOperation = {
  kind: 'agent' | 'compact';
  controller: AbortController;
};
```

执行 `/compact` 时：

1. 同步注册 `compact` 前台操作；
2. 清零本次 token 数量；
3. 显示 `状态 › 运行中 · 正在压缩历史 · Ctrl+C 中止`；
4. 隐藏输入框并显示输入锁定提示；
5. 把同一个 `AbortSignal` 传给摘要模型流；
6. 成功、失败或中止后都在 `finally` 清理前台状态并恢复输入。

压缩期间的普通文字、斜杠命令和回车均被忽略，不进入会话记录。第一次 `Ctrl+C` 只中止压缩；第二次才保存并退出。压缩中止不伪造普通代理任务的 `interrupted` 会话事件。

## 思考流、回答流与 token 状态

OpenAI-compatible 适配器按 DeepSeek Chat Completions 的流式协议识别两类增量：

```ts
type ModelEvent =
  | {type: 'reasoning_delta'; text: string}
  | {type: 'text_delta'; text: string}
  | ...
```

- `delta.reasoning_content` 转成 `reasoning_delta`；
- `delta.content` 继续转成 `text_delta`；
- 不返回 `reasoning_content` 的普通模型保持兼容，直接进入回答流；
- 带工具调用的一轮会把该轮 `reasoning_content` 连同 assistant 工具调用消息送回模型，以兼容思考模型的工具调用协议；
- 推理内容不写入会话或审计文件，只在当前终端会话显示；最终回答仍按现有规则持久化。

终端使用独立的实时区块，不再等完整响应结束后一次性出现：

```text
思考 ›
正在检查文件工具的参数协议……

浩宸 ›
问题出在安全边界没有接受 limit。
```

收到首个 `reasoning_delta` 时显示“思考中”；收到首个 `text_delta` 时立即认定推理阶段已经结束，切换为“思考完成 · 正在回答”，不等待 `finish` 或 `finish.usage`。一轮结束后将两个实时区块定稿，工具调用开始时仍保留已显示内容。思考流和回答流不得共用相同前缀，也不得重复输出。

终端 token 数量采用用户指定的流增量计数，不使用供应商的分词统计：

- 每收到一次非空 `reasoning_delta`，计数加 `1`；
- 每收到一次非空 `text_delta`，计数加 `1`；
- 工具调用参数分片、空字符串、`finish` 和 `finish.usage` 不增加计数；
- 最终回答的全部 `text_delta` 与推理增量使用同一累计值；
- 新的代理任务或压缩开始时计数归零，完成后保留最后数量，直到下一次模型操作。

这里界面沿用用户要求的 `tokens` 标签，但其精确定义是“模型返回的非空推理/回答流增量次数”，不是供应商 tokenizer 的真实分词数量。供应商返回的 `usage` 不覆盖该数值，也不驱动状态变化。

底部状态栏始终存在：

```text
↓ 0 tokens · 思考完成
↓ 842 tokens · 思考中
↓ 12.1k tokens · 思考完成 · 正在回答
↓ 12.4k tokens · 思考完成
```

格式规则：

- 小于 1000 时显示整数；
- `1000..999999` 使用最多一位小数的 `k`；
- 更大数值使用最多一位小数的 `m`；
- 正在接收推理增量或等待模型首段内容时显示“思考中”；首个回答增量到达后立即显示“思考完成 · 正在回答”；回答或工具轮次结束后显示“思考完成”；
- 运行阶段、审批等待和输入锁定仍使用现有独立状态行，不与 token 状态混在一起。

## 错误处理

- 文件字符偏移超过所选内容时返回 `INVALID_CHARACTER_RANGE`；
- 字符分页参数不是整数或超出范围时在确定性边界和工具层一致拒绝；
- `web_search.limit` 超出 `1..10` 时确定性拒绝；
- `/compact` 抛出的异常转换为可见错误条目，不产生未处理 Promise rejection；
- `/compact` 中止显示明确中止结果并恢复输入；
- `finish.usage` 缺失不影响计数、模型响应协议和任务完成。

## 测试与验收

### 文件工具

- 70 KiB 单行文件默认读取成功、被标记为截断并返回 `nextCharacter`；
- 使用 `nextCharacter` 续读后可以无损拼回原内容；
- emoji 位于分页边界时不被拆坏；
- 超长行位于请求范围外时不再令读取失败；
- 单次内容不超过 65,536 个 Unicode 字符；
- 2 MiB + 1 字节文件仍被拒绝；
- 确定性边界和模型 Schema 接受合法字符分页参数并拒绝非法参数。

### 联网搜索

- `{query, limit: 5}` 通过确定性边界并执行；
- `limit` 为 `0`、`11` 或非整数时被拒绝；
- 不同 `limit` 产生不同规范化范围和指纹；
- 模型公开的 JSON Schema 标注 `minimum: 1`、`maximum: 10`。

### 终端

- 慢 `/compact` 显示进度和输入锁定；
- 压缩期间输入不会进入记录，也不会启动代理任务；
- 第一次 `Ctrl+C` 中止压缩但不退出，状态最终恢复；
- `reasoning_content` 与 `content` 按到达顺序分别流入“思考”和“浩宸”区块；
- 不提供 `reasoning_content` 的模型仍能正常流式显示回答；
- 工具调用轮次把推理字段正确送回模型，终端不重复显示已完成区块；
- 普通任务和多轮工具调用累计所有非空推理与回答流增量；
- 首个回答增量到达时立即显示“思考完成 · 正在回答”；
- 最终回答的每个流增量都按一次一个 token 继续累计；
- 新任务清零旧 token 数量；
- 空闲、运行中和完成后的底部状态文案正确；
- `finish.usage` 缺失或与流增量数量不一致时不覆盖界面计数。

### 全量交付

- `npm test`、`npm run typecheck`、`npm run build` 全部通过；
- 标准入口和单文件入口均能输出版本；
- 全局安装包更新后，本机 `haochen --version` 可用；
- GitHub Actions 的 Windows、Ubuntu、macOS Node 20 矩阵全部通过。

## 非目标

- 不移除 2 MiB 文件总上限；
- 不把 Shell 命令作为读取压缩文件的默认后备；
- 不伪造或自行生成推理内容；只显示供应商通过公开响应字段返回的 `reasoning_content`；
- 不把 token 数量写入会话或审计日志；
- 不在本轮重构 `/diff`、`/clear`、`/resume` 的全部异步状态，只保证 `/compact` 与代理任务互斥。
