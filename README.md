> [!CAUTION]
> **纯恶搞项目，请勿用于真实开发。**
> 本仓库只用于玩梗和实验，不保证正确性、安全性、数据完整性或兼容性。不要让它接触生产项目、重要代码、真实凭据或任何无法恢复的数据。
>
> **PARODY PROJECT — DO NOT USE FOR REAL WORK.**
> This repository is a joke and experiment. No guarantees of correctness, security, data integrity, or compatibility are provided. Do not use it with production projects, important source code, real credentials, or irreplaceable data.

# 浩宸信号

“浩宸信号”（Haochen Signal）是一个以“苏浩宸、狼王与信号场”世界观为交互语言的 AI 编程 CLI。它通过持续式终端会话读取项目、编辑文件、执行命令、使用 Git、检索公开技术资料，并在完成前运行验证。

世界观负责命名和氛围；真实路径、命令、差异、退出码、错误与权限理由始终以清晰的技术形式呈现。

完整《浩宸宇宙：狼王与信号场设定集》随主代理系统提示词内置，因此每次主代理请求都会固定占用一部分输入上下文。工具规则、权限边界、用户任务与技术证据始终优先于虚构设定；无工具权限的红眼审查提示词不会注入这份世界观。

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
haochen --version
haochen
```

### Windows PowerShell

```powershell
npm install --global .
haochen --version
haochen
```

也可以在源码仓库中运行 `npm install` 后执行 `npm run dev`。

## 配置

API Key 按以下顺序读取：

1. 供应商专属环境变量，格式为 `HAOCHEN_PROVIDER_<供应商 ID 每个 UTF-16 code unit 的四位十六进制>_API_KEY`；例如稳定 ID `deepseek` 对应 `HAOCHEN_PROVIDER_0064006500650070007300650065006B_API_KEY`。该可逆编码区分大小写、标点、非 ASCII ID、未配对代理项和替换字符；只有同时满足 `provider.id === legacy-provider` 与 `credentialRef === legacy` 的迁移供应商继续兼容 `HAOCHEN_API_KEY`；
2. 仅 macOS 的 Keychain；新版条目以 `haochen-signal:<同一 UTF-16 可逆十六进制后缀>` 区分供应商，例如 `deepseek` 使用 `haochen-signal:0064006500650070007300650065006B`，服务名不包含原始供应商 ID。解析方必须显式允许 legacy 回退，且只有同时满足上述 ID 和引用条件时，才会读取服务名 `haochen-signal`、账户名 `haochen` 的旧条目；
3. 当前任务第一次使用该供应商时隐藏输入，且只保存在当前进程中。

首次运行不会强制询问供应商、模型或 API Key，而是创建空的 v2 配置并直接进入信号场。此时 `/help`、`/model`、`/resume`、`/diff` 和 `/exit` 等本地命令仍可使用；普通问题会显示“未绑定模型，请先使用 /model 配置并选择模型。”，`/compact` 也会明确说明必须先绑定模型，二者都不会发起模型请求或锁住输入。

通过 `/model` 添加供应商时，API Key 使用隐藏输入且不会写入配置 JSON。macOS 会按供应商保存到 Keychain；Linux 和 Windows 只保留当前进程凭据。对于配置中已有、但当前进程尚未解析到凭据的供应商，第一次实际任务会在 Ink 界面内显示独立的圆点掩码输入；它与普通命令共用 Ink 已接管的 stdin，不会另建 readline、切换 raw mode 或把 Key 写入终端转录。提交后输入立即恢复，下一条本地命令可直接使用。旧配置迁移出的 `legacy-provider` 仍可回退读取 `HAOCHEN_API_KEY` 与旧 Keychain 条目；新供应商不会读取这两个全局旧来源。

添加供应商或向现有供应商追加模型时，可向规范化后的 `{baseUrl}/models` 发起 OpenAI-compatible `GET` 请求。现有供应商会复用原 provider、API 地址和已经解析的临时凭据、专属环境变量或 Keychain 条目，不会创建重复 provider；也可直接手动填写 Model ID。响应体最多为 2 MiB，只接受对象中的非空 `data[].id`；模型 ID 会去重并按确定性字典序排列。选择模型后，最大上下文会优先采用供应商返回的 `context_window`、`context_length` 等元数据；缺失时用不携带 API Key 的公开 `models.dev` 目录补全，目录不可用或仍查不到时才回退到可手动修改的 128000。旧版单模型配置首次升级时也会通过同一公开目录补全仍为 128000 默认值的上下文并立即保存成 v2，后续启动不重复刷新。请求支持取消和超时，响应正文、认证头与 API Key 不会进入界面错误。错误边界不会对未知抛出值执行 `instanceof`；只在 `typeof` 证明可作为 WeakMap 键时查询内部错误，恶意 Proxy 的原型 trap 不会绕过 total 脱敏。

最直接的启动方式是：

```bash
haochen
```

默认配置文件位于 `~/.config/haochen/config.json`。新版配置用稳定 ID 关联多个供应商和模型，API Key 只保存凭据引用，不写入该 JSON：

```json
{
  "version": 2,
  "providers": [
    {
      "id": "provider-example",
      "name": "Example",
      "baseUrl": "https://api.example.com/v1",
      "credentialRef": "provider-example",
      "headers": {"x-project": "example"}
    }
  ],
  "models": [
    {
      "id": "model-example-signal-main",
      "providerId": "provider-example",
      "modelId": "signal-main",
      "displayName": "Signal Main",
      "contextWindow": 128000
    }
  ],
  "activeModelId": "model-example-signal-main",
  "timeoutMs": 60000
}
```

- `providers[].baseUrl`：不含用户凭据的 HTTP(S) API 根地址，不含 `/chat/completions`；
- `providers[].credentialRef`：供应商凭据引用，不是 API Key；
- `models[].modelId`：发送给供应商的真实模型 ID；
- `models[].displayName`：终端显示名称；
- `models[].contextWindow`：模型上下文长度，最小为 8000；通过模型发现添加时自动识别，无法识别或手动添加时默认 128000；
- `activeModelId`：当前模型的稳定本地 ID；
- `timeoutMs`：单次模型请求的无流量超时，范围为 1 至 300 秒；每收到一个响应流分片都会重新计时，因此持续思考或回答不会在固定总时长到达时被强制截断；

旧版单供应商配置会在加载时迁移到 v2 内存结构，并在首次实际保存模型设置时原子写回。每个代理任务和 `/compact` 开始时都会重新读取当前 `activeModelId`、对应供应商与该供应商凭据；客户端按供应商请求配置和凭据身份复用。切换模型不会更换会话 ID，但下一轮会使用新供应商客户端、真实 `modelId` 和 `contextWindow`，红眼审查默认复用同一轮的当前客户端与模型。

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
- `思考 ›`：供应商返回的 `reasoning_content` 推理流；回答尚未开始时保持可见，任意非空回答开始输出后会与本轮此前的工具、审批和结果一起自动收起；若回答前发生错误或中止则继续保留，且这些内容绝不写入会话或审计日志；
- `浩宸 ›`：供应商返回的 `content` 回答流，以及代理的最终回答；
- `工具 › <名称>`：每次调用固定占一行，合并显示真实工具名、经过脱敏和截断的参数摘要及成功或失败结果；
- `审批 › <名称>`：确定性边界、AI 自动审查、人工选择或会话许可的真实结论；回答开始后随本轮过程自动收起；
- `结果 › <名称>`：仅在缺少对应工具开始事件的异常回退路径中独立显示；
- `状态 › 运行中`：任务活动期间持续显示当前阶段和 `Ctrl+C` 中止提示。

底部的 `↓ tokens` 是当前前台操作收到的非空推理/回答流增量次数：每个非空 `reasoning_delta` 或 `text_delta` 固定算 1 个 token，也适用于 `/compact` 的摘要流；它不是 tokenizer 的真实分词数量。常驻的 `上下文 used / max` 独立使用最近一次合法模型 `finish.usage` 的输入、输出 token 之和与当前模型上下文上限；从未收到真实 usage 时已用量显示 0，新任务只清零流分片计数。工具调用、自动审查、人工确认或上传阶段额外显示 `↑ … tokens · 上一轮总量`，同一模型轮的多个工具复用同一总量，不重复累计；本轮 usage 缺失时明确显示“上一轮总量未知”，不会拿 `↓` 分片数冒充。进入下一次模型流或最终回答完成后，上箭头自动隐藏。`/compact` 的每个非空增量会在摘要 Promise 完成前立即更新底部计数，结束时只用精确总数对齐，不会把实时值重复累加。首个非空 `content` 增量一到达，阶段即显示为“思考完成 · 正在回答”；一轮模型响应结束后显示为“思考完成”。

黄色运行状态持续显示本任务真实工具调用次数与上限。工具预算耗尽后，Agent 会停止执行新工具，并基于已有对话和工具结果完成一次禁止工具的最终说明；未执行的溢出调用不计入次数。

`/compact` 与代理任务共用唯一的前台操作：压缩期间输入会锁定，底部显示实时状态和增量计数。摘要追加开始前取消会阻止持久化；追加一旦开始就是不可逆提交点，此后的取消不会撤销已经开始的追加，也不会把成功误报为中止。未提交的中止结果不会显示成功或套用伪造的最终计数。第一次 `Ctrl+C` 只会请求中止压缩，不会退出程序或写入代理任务的中断记录；如果压缩 Promise 仍未完成收尾，第二次 `Ctrl+C` 会保存会话并退出，但仍不会写入代理任务的中断记录。

`read_file` 的单次读取最多返回 65,536 个 Unicode 码点。超长单行未读完时，结果会给出 `nextCharacter`；代理可保持相同的 `path`、`startLine` 和 `endLine`，把该值作为下一次的 `startCharacter` 继续读取，因此不会拆开 Unicode 码点。`web_search.query` 会先去除首尾空白，规范化后的长度必须为 1 至 500；`limit` 可省略（默认 10），或指定为 1 至 10 的整数。Zod、模型 JSON Schema 的 ECMA-262 pattern、确定性边界、审批指纹和实际执行使用同一套范围，因此首尾空白不会错误占用 500 字符正文的额度。若本机代理仅返回 `198.18.0.0/15` Fake-IP，搜索工具会通过固定公网 DNS-over-HTTPS 重新解析搜索端点，再把验证后的公网地址固定到实际连接；普通私网 DNS 结果仍会直接拒绝。

`write_file` 只用于创建工作区内的新 UTF-8 文件：父目录必须已经存在，目标及任一路径组件不能是符号链接，目标已存在时会返回 `FILE_EXISTS` 而不会覆盖。内容经同目录临时文件完成写入、同步后再原子发布；调用硬链接发布前会做最后一次中止检查，硬链接调用一旦开始便是不可逆提交点，不会再用 `lstat + unlink` 回滚已发布路径。若取消发生在发布期间，代理会等待变更工具返回，先显示并记录真实的创建成功，再记录任务中断，且不会进入下一轮模型请求。工具摘要和审计输入只记录规范化路径、字符数及内容摘要，不记录正文。修改或删除已有文件继续使用 `apply_patch`。

“无需 AI 审查，确定性边界直接放行”表示操作没有调用审查模型；只有实际进入红眼审查的操作才会显示“AI 自动审查通过/拒绝/转人工”。补丁参数只显示操作类型和目标路径，不显示补丁正文；API Key、认证头、Cookie、令牌与私钥继续显示为 `[REDACTED]`。

普通问候、寒暄和能力询问不会触发文件、Git 或网络工具。任务执行期间输入区域会显示锁定提示，只接受 `Ctrl+C` 中止；任务结束后自动恢复输入。`list_files` 的递归结果最多返回 500 个文件，并以请求目录为基准优先返回浅层文件、同层按完整相对路径排序；超过上限会明确显示“已截断”，更深层文件会先被舍弃，避免在大型工作区或用户主目录中无限扫描。

| 命令 | 功能 |
|---|---|
| `/help` | 查看帮助 |
| `/status` | 查看会话、模型、工作区和上下文状态 |
| `/model` | 打开独立模型配置界面 |
| `/diff` | 查看当前 Git 差异 |
| `/permissions` | 查看权限规则和本次会话许可 |
| `/compact` | 主动压缩会话上下文 |
| `/clear` | 新建空白会话 |
| `/resume [ID]` | 恢复指定会话；不带 ID 时打开工作区会话选择器 |
| `/exit` | 保存并退出 |

所有斜杠命令只由本地界面处理，不会发送给模型。`/diff` 只调用固定的只读 Git 工具。

`/model` 会隐藏普通输入和斜杠命令建议。列表按供应商分组，按 `↑/↓` 跨组选择模型、`Enter` 切换、`A` 添加模型、`E` 编辑显示名称和最大上下文、`D` 删除、`Esc` 返回；空列表只显示添加供应商入口，不显示无效光标。已有模型被选中时，`A` 会明确询问“添加到当前供应商”或“添加新供应商”；供应商动作页同时显示 API 地址和可直接配置的专属环境变量名。新供应商向导依次输入名称、API 地址和隐藏的 API Key；两种添加路径都可获取 `/models` 列表或手动填写 Model ID，随后把模型追加到对应 provider。选中模型后显示名称默认等于 Model ID，最大上下文默认 128000。切换会立即更新底栏最大上下文，并按模型隔离最近一次真实 usage；删除模型后其 usage 缓存同步移除，因此重新添加相同本地 ID 也从 0 开始。配置保存按请求串行执行，并在临时文件重命名前响应取消；`rename` 调用一旦开始便进入提交点，若随后取消但重命名成功，磁盘和全局运行时会按实际持久化成功顺序接纳该次保存。若后续 B 成功则最终以 B 为准；若 B 在开始前取消或持久化失败，则保留 A，并把仍显示 B 编辑状态的界面协调回最新已提交的 A。操作身份只用于阻止旧 Promise 覆盖当前编辑状态，不会否定已经成功的全局提交。

不带参数执行 `/resume` 会打开当前工作区的会话选择器：按 `↑/↓` 选择、`Enter` 恢复、`Esc` 取消。列表显示更新时间、首条用户输入预览和短 ID；旧版未记录工作区归属的会话位于“工作区未知”分组，其他工作区的会话不会混入。`/resume <ID>` 仍可直接使用。

终端以 Ink 渲染信号场状态：`◆` 表示扫描、读取或修改，`◇` 表示验证，`◉` 表示红眼审查，`✓` 只表示最终完成，`✗` 表示失败。模型在调用工具前的中间说明以普通条目显示；工具失败会显示真实退出码和标准错误摘要，不会伪装为完成。

Ink 入口关闭框架自带的抢先退出，把 `Ctrl+C` 统一交给 App 的前台操作状态机。任务运行时，第一次按键会中止当前模型流、工具进程或等待中的供应商凭据提示，并恢复普通输入而不会退出；任务仍在收尾时再次按下会把唯一中断事件写入任务开始时绑定的会话，再保存并退出，后续 `/clear` 或 `/resume` 不会让旧 writer 污染新会话。模型配置正在发现或保存时，第一次 `Ctrl+C` 会中止该操作并返回可编辑动作页，紧接第二次会保存会话并退出；模型配置空闲时按一次即退出。主界面空闲时按一次 `Ctrl+C` 会保存并退出。被中止的会话仍可恢复。

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

### 核心模块结构

以下三个文件保留既有导入路径，作为兼容门面；实现按职责放在同名内部目录，新增功能应优先落入对应职责模块：

- `src/tools/files.ts` → `src/tools/files/`：文件访问、读取、搜索、写入与补丁计划/执行；
- `src/tools/command.ts` → `src/tools/command/`：命令运行、进程控制、输出日志与平台进程树处理；
- `src/security/boundary.ts` → `src/security/boundary/`：文件、命令、网络及其他工具的确定性边界分类。

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
