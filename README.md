> [!CAUTION]
> **纯恶搞项目，请勿用于真实开发。**
> 本仓库只用于玩梗和实验，不保证正确性、安全性、数据完整性或兼容性。不要让它接触生产项目、重要代码、真实凭据或任何无法恢复的数据。
>
> **PARODY PROJECT — DO NOT USE FOR REAL WORK.**
> This repository is a joke and experiment. No guarantees of correctness, security, data integrity, or compatibility are provided. Do not use it with production projects, important source code, real credentials, or irreplaceable data.

# 浩宸信号

“浩宸信号”（Haochen Signal）是一个以“苏浩宸、狼王与信号场”世界观为交互语言的 AI 编程 CLI。它通过持续式终端会话读取项目、编辑文件、执行命令、使用 Git、检索公开技术资料，并在完成前运行验证。

世界观负责命名和氛围；真实路径、命令、差异、退出码、错误与权限理由始终以清晰的技术形式呈现。

## 安装

需要 Node.js 20 或更高版本。本包尚未发布到 npm，以下从源码全局安装的方式是有意设计。

| 平台 | 终端 | 安装命令 | 自动化验证 | 凭据方式 |
|---|---|---|---|---|
| macOS | POSIX Shell | `npm install --global .` | `macos-latest` | 环境变量、Keychain 或本次隐藏输入 |
| Linux | POSIX Shell | `npm install --global .` | `ubuntu-latest` | 环境变量或本次隐藏输入 |
| Windows | Windows PowerShell | `npm install --global .` | `windows-latest` | 环境变量或本次隐藏输入 |

### macOS / Linux（POSIX Shell）

```bash
npm install --global .
export HAOCHEN_API_KEY='你的 API Key'
haochen --version
```

### Windows PowerShell

```powershell
npm install --global .
$env:HAOCHEN_API_KEY='你的 API Key'
haochen --version
```

也可以在源码仓库中运行 `npm install` 后执行 `npm run dev`。

## 配置

API Key 按以下顺序读取：

1. 供应商专属环境变量，格式为 `HAOCHEN_PROVIDER_<供应商 ID 每个 UTF-16 code unit 的四位十六进制>_API_KEY`；例如稳定 ID `deepseek` 对应 `HAOCHEN_PROVIDER_0064006500650070007300650065006B_API_KEY`。该可逆编码区分大小写、标点、非 ASCII ID、未配对代理项和替换字符；只有同时满足 `provider.id === legacy-provider` 与 `credentialRef === legacy` 的迁移供应商继续兼容 `HAOCHEN_API_KEY`；
2. 仅 macOS 的 Keychain；新版条目以 `haochen-signal:<同一 UTF-16 可逆十六进制后缀>` 区分供应商，例如 `deepseek` 使用 `haochen-signal:0064006500650070007300650065006B`，服务名不包含原始供应商 ID。解析方必须显式允许 legacy 回退，且只有同时满足上述 ID 和引用条件时，才会读取服务名 `haochen-signal`、账户名 `haochen` 的旧条目；
3. 启动时临时输入，且只保存在当前进程中。

首次运行会依次询问 API 地址、模型和 API Key；API Key 使用隐藏输入，终端必须保持在 Key 提示处等待输入，不会回显凭据。只有 macOS 会询问是否保存到 Keychain；Linux 和 Windows 请使用环境变量或本次启动的隐藏输入。

添加供应商时可向规范化后的 `{baseUrl}/models` 发起 OpenAI-compatible `GET` 请求。响应体最多为 2 MiB，只接受对象中的非空 `data[].id`；模型 ID 会去重并按确定性字典序排列。请求支持取消和超时，响应正文、认证头与 API Key 不会进入界面错误。错误边界不会对未知抛出值执行 `instanceof`；只在 `typeof` 证明可作为 WeakMap 键时查询内部错误，恶意 Proxy 的原型 trap 不会绕过 total 脱敏。

最直接的启动方式是：

```bash
export HAOCHEN_API_KEY='你的 API Key'
haochen
```

默认配置文件位于 `~/.config/haochen/config.json`。可配置任意 OpenAI-compatible Chat Completions 地址、主模型和独立审查模型：

```json
{
  "baseUrl": "https://api.example.com/v1",
  "model": "signal-main",
  "reviewModel": "signal-review",
  "headers": {
    "x-project": "example"
  },
  "timeoutMs": 60000,
  "contextWindow": 128000
}
```

- `baseUrl`：不含用户凭据的 HTTP(S) API 根地址，不含 `/chat/completions`；
- `model`：主代理模型；
- `reviewModel`：红眼审查模型；省略时与主模型相同；
- `headers`：端点需要的额外请求头；
- `timeoutMs`：单次模型请求的无流量超时，范围为 1 至 300 秒；每收到一个响应流分片都会重新计时，因此持续思考或回答不会在固定总时长到达时被强制截断；
- `contextWindow`：模型上下文长度，最小为 8000。

## 交互使用

在需要处理的项目目录中运行 `haochen`，然后直接描述目标：

```text
╭─ 浩宸信号 · HAOCHEN SIGNAL ──────────────────╮
│ 身份确认——浩宸代理，已进入信号场。            │
│ 项目  ~/projects/example     模型  signal-1    │
╰───────────────────────────────────────────────╯

浩宸 › 修复登录接口偶发返回 500 的问题，并运行相关测试
◆ 扫描信号     搜索登录接口与错误处理
◆ 读取碎片     src/auth/login.ts
◆ 修改节点     src/auth/login.ts  +12 -4
◇ 执行验证     npm test -- auth
✓ 任务完成      相关测试 8/8 通过
```

CLI 只提供持续式交互会话；首版没有执行一次即退出的任务模式。启动参数为：

- `haochen --help` 或 `haochen -h`：显示帮助；
- `haochen --version` 或 `haochen -v`：显示版本。

信号场内置斜杠命令：

进入主界面前会清空当前终端的可见区域和回滚缓冲。输入 `/` 会立即显示匹配的命令面板，继续输入可筛选，按 `Tab` 补全第一项；所有已提交的用户输入都会保留在会话界面中。

会话记录使用不同分区显示：

- `你 ›`：已提交的用户输入；
- `思考 ›`：供应商返回的 `reasoning_content` 推理流；每轮结束后会定稿为仅存在于当前进程内的终端条目，因此纯推理工具轮次、连续工具轮次和异常终态都不会让已显示的思考消失，但这些内容绝不写入会话或审计日志；
- `浩宸 ›`：供应商返回的 `content` 回答流，以及代理的最终回答；
- `工具 › <名称>`：真实工具名及经过脱敏、截断的参数摘要；
- `审批 › <名称>`：确定性边界、AI 自动审查、人工选择或会话许可的真实结论；
- `结果 › <名称>`：工具成功结果；失败使用红色错误分区；
- `状态 › 运行中`：任务活动期间持续显示当前阶段和 `Ctrl+C` 中止提示。

底部的 `↓ tokens` 是当前前台操作收到的非空推理/回答流增量次数：每个非空 `reasoning_delta` 或 `text_delta` 固定算 1 个 token，也适用于 `/compact` 的摘要流；它不是 tokenizer 的真实分词数量。常驻的 `上下文 used / max` 独立使用最近一次合法模型 `finish.usage` 的输入、输出 token 之和与当前模型上下文上限；从未收到真实 usage 时已用量显示 0，新任务只清零流分片计数。工具调用、自动审查、人工确认或上传阶段额外显示 `↑ … tokens · 上一轮总量`，同一模型轮的多个工具复用同一总量，不重复累计；本轮 usage 缺失时明确显示“上一轮总量未知”，不会拿 `↓` 分片数冒充。进入下一次模型流或最终回答完成后，上箭头自动隐藏。`/compact` 的每个非空增量会在摘要 Promise 完成前立即更新底部计数，结束时只用精确总数对齐，不会把实时值重复累加。首个非空 `content` 增量一到达，阶段即显示为“思考完成 · 正在回答”；一轮模型响应结束后显示为“思考完成”。

`/compact` 与代理任务共用唯一的前台操作：压缩期间输入会锁定，底部显示实时状态和增量计数。摘要追加开始前取消会阻止持久化；追加一旦开始就是不可逆提交点，此后的取消不会撤销已经开始的追加，也不会把成功误报为中止。未提交的中止结果不会显示成功或套用伪造的最终计数。第一次 `Ctrl+C` 只会请求中止压缩，不会退出程序或写入代理任务的中断记录；如果压缩 Promise 仍未完成收尾，第二次 `Ctrl+C` 会保存会话并退出，但仍不会写入代理任务的中断记录。

`read_file` 的单次读取最多返回 65,536 个 Unicode 码点。超长单行未读完时，结果会给出 `nextCharacter`；代理可保持相同的 `path`、`startLine` 和 `endLine`，把该值作为下一次的 `startCharacter` 继续读取，因此不会拆开 Unicode 码点。`web_search.query` 会先去除首尾空白，规范化后的长度必须为 1 至 500；`limit` 可省略（默认 10），或指定为 1 至 10 的整数。Zod、模型 JSON Schema 的 ECMA-262 pattern、确定性边界、审批指纹和实际执行使用同一套范围，因此首尾空白不会错误占用 500 字符正文的额度。若本机代理仅返回 `198.18.0.0/15` Fake-IP，搜索工具会通过固定公网 DNS-over-HTTPS 重新解析搜索端点，再把验证后的公网地址固定到实际连接；普通私网 DNS 结果仍会直接拒绝。

`write_file` 只用于创建工作区内的新 UTF-8 文件：父目录必须已经存在，目标及任一路径组件不能是符号链接，目标已存在时会返回 `FILE_EXISTS` 而不会覆盖。内容经同目录临时文件完成写入、同步后再原子发布；工具摘要和审计输入只记录规范化路径、字符数及内容摘要，不记录正文。修改或删除已有文件继续使用 `apply_patch`。

“无需 AI 审查，确定性边界直接放行”表示操作没有调用审查模型；只有实际进入红眼审查的操作才会显示“AI 自动审查通过/拒绝/转人工”。补丁参数只显示操作类型和目标路径，不显示补丁正文；API Key、认证头、Cookie、令牌与私钥继续显示为 `[REDACTED]`。

普通问候、寒暄和能力询问不会触发文件、Git 或网络工具。任务执行期间输入区域会显示锁定提示，只接受 `Ctrl+C` 中止；任务结束后自动恢复输入。`list_files` 的递归结果最多返回 500 个文件，超过上限会明确显示“已截断”，避免在大型工作区或用户主目录中无限扫描。

| 命令 | 功能 |
|---|---|
| `/help` | 查看帮助 |
| `/status` | 查看会话、模型、工作区和上下文状态 |
| `/model [名称]` | 查看或仅切换当前会话模型 |
| `/diff` | 查看当前 Git 差异 |
| `/permissions` | 查看权限规则和本次会话许可 |
| `/compact` | 主动压缩会话上下文 |
| `/clear` | 新建空白会话 |
| `/resume [ID]` | 恢复指定会话；不带 ID 时打开工作区会话选择器 |
| `/exit` | 保存并退出 |

所有斜杠命令只由本地界面处理，不会发送给模型。`/diff` 只调用固定的只读 Git 工具。

不带参数执行 `/resume` 会打开当前工作区的会话选择器：按 `↑/↓` 选择、`Enter` 恢复、`Esc` 取消。列表显示更新时间、首条用户输入预览和短 ID；旧版未记录工作区归属的会话位于“工作区未知”分组，其他工作区的会话不会混入。`/resume <ID>` 仍可直接使用。

终端以 Ink 渲染信号场状态：`◆` 表示扫描、读取或修改，`◇` 表示验证，`◉` 表示红眼审查，`✓` 只表示最终完成，`✗` 表示失败。模型在调用工具前的中间说明以普通条目显示；工具失败会显示真实退出码和标准错误摘要，不会伪装为完成。

任务运行时，第一次按 `Ctrl+C` 会中止当前模型流或工具进程；任务仍在运行时再次按下会先持久化唯一中断事件，再保存会话并退出。空闲时按一次 `Ctrl+C` 会保存并退出。被中止的会话仍可恢复。

## 权限与红眼审查

每个工具调用都先经过确定性的“边界守卫”：

- 工作区内读取、搜索、结构化补丁、固定只读 Git 操作和已识别的低风险验证可以直接执行；
- 安装依赖、未识别的项目命令、后台进程、复杂 Shell 或可能外发项目内容的网络请求进入独立“红眼审查”；
- `sudo`、修改系统权限、工作区外删除、覆盖 Git 历史、读取系统凭据和向外部服务发布内容必须人工确认；
- 路径越界、符号链接越界、非公开网络目标和已确定的危险操作直接拒绝。

红眼审查器没有工具权限，只能评估原调用。自动批准仅对工具名、参数和规范化影响范围完全相同的一次执行有效；参数变化会重新分类。审查超时、响应无效、范围扩大或风险冲突都会转为人工确认。

确认界面会显示工具、风险与规范化范围：按 `a` 仅允许本次，按 `s` 允许本次会话内完全相同的操作，按 `d` 拒绝。非交互终端会明确拒绝确认请求。

## 会话、审计与隐私

“王冠记录”分为追加式会话日志和审计日志，默认位置为：

```text
~/.local/share/haochen/sessions/
~/.local/state/haochen/audit/
```

工作区使用绝对路径的不可逆摘要作为索引；项目内不会自动创建会话目录。记录写入前统一脱敏，不保存 API Key、完整环境变量、认证请求头或检测出的高置信度凭据。工具输出具有行数和字节上限，超出部分写入受限的系统临时文件，只把摘要与必要片段送入模型上下文。

## 构建

```bash
npm run build
```

构建会同时生成：

- `dist/cli.mjs`：标准发布入口，运行依赖保持为外部 npm 包；
- `dist/haochen-onefile.mjs`：包含应用源码和全部运行依赖的非压缩单文件。

两个文件都带有唯一的 `#!/usr/bin/env node` 首行并设置为 `0755`。单文件版本用于携带和检查，不是 npm `haochen` 命令的默认入口：

```bash
node dist/cli.mjs --help
node dist/haochen-onefile.mjs --help
```

## 开发、测试与发布

```bash
npm run dev
npm test
npm run test:integration
npm run typecheck
npm run build
npm pack --dry-run
```

`npm pack --dry-run` 的发布白名单只包含 `package.json`、中文 README、CHANGELOG 和两个构建产物。`prepack` 会重新执行双构建，避免发布过期文件。

## 设计文档

- [设计规格](docs/superpowers/specs/2026-07-25-haochen-signal-design.md)
- [实施计划](docs/superpowers/plans/2026-07-25-haochen-signal-implementation.md)

## 开发约定

- README、CHANGELOG 和项目说明使用中文；
- 正常源码保持模块化，超大单文件只由构建流程生成；
- 敏感信息不得写入项目、会话或审计日志；
- 所有工具都必须先通过结构校验、边界分类和必要的红眼审查或人工确认；
- 红眼审查模型由调用方显式指定，自动批准不得提高风险、扩大范围或附带无法验证的约束；
- 工具执行前必须确认审计记录可追加，执行后的审计故障必须保留真实结果并附加警告；
- 主代理严格核对纯文本 `stop` 与工具 `tool_calls` 协议，整批调用先校验非空唯一 ID 和合法 JSON，再按出现顺序执行；决定需要工具后必须立即调用，禁止在行动前反复规划同一方案；
- 主代理不自动重试工具，失败结果交给模型基于真实错误重新规划；会话写入保持串行，中止记录位于所有已开始写入之后；
- Vitest 默认排除项目内的隔离工作树，避免并行分支中的同名测试被重复执行；
- 本地导出的源码包、npm 包和可执行构建统一放在 Git 忽略的 `outputs/` 目录；
- 每次项目修改同步更新 CHANGELOG，并提交到 Git。
