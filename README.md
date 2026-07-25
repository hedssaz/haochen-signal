# 浩宸信号

“浩宸信号”（Haochen Signal）是一个以“苏浩宸、狼王与信号场”世界观为交互语言的 AI 编程 CLI。它通过持续式终端会话读取项目、编辑文件、执行命令、使用 Git、检索公开技术资料，并在完成前运行验证。

世界观负责命名和氛围；真实路径、命令、差异、退出码、错误与权限理由始终以清晰的技术形式呈现。

## 安装

需要 Node.js 20 或更高版本。

```bash
npm install --global haochen-signal
haochen --version
```

也可以在源码仓库中运行：

```bash
npm install
npm run dev
```

## 配置

API Key 按以下顺序读取：

1. `HAOCHEN_API_KEY` 环境变量；
2. macOS Keychain 中服务名为 `haochen-signal`、账户名为 `haochen` 的凭据；
3. 启动时临时输入，且只保存在当前进程中。

首次运行会依次询问 API 地址、模型和 API Key；API Key 使用隐藏输入，随后可选择是否保存到 macOS 钥匙串。终端必须保持在 Key 提示处等待输入，不会回显凭据。

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
- `timeoutMs`：单次模型请求的总超时，范围为 1 至 300 秒；
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

| 命令 | 功能 |
|---|---|
| `/help` | 查看帮助 |
| `/status` | 查看会话、模型、工作区和上下文状态 |
| `/model [名称]` | 查看或仅切换当前会话模型 |
| `/diff` | 查看当前 Git 差异 |
| `/permissions` | 查看权限规则和本次会话许可 |
| `/compact` | 主动压缩会话上下文 |
| `/clear` | 新建空白会话 |
| `/resume [ID]` | 恢复指定会话；不带 ID 时列出最近十个 |
| `/exit` | 保存并退出 |

所有斜杠命令只由本地界面处理，不会发送给模型。`/diff` 只调用固定的只读 Git 工具。

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
- 主代理严格核对纯文本 `stop` 与工具 `tool_calls` 协议，整批调用先校验非空唯一 ID 和合法 JSON，再按出现顺序执行；
- 主代理不自动重试工具，失败结果交给模型基于真实错误重新规划；会话写入保持串行，中止记录位于所有已开始写入之后；
- Vitest 默认排除项目内的隔离工作树，避免并行分支中的同名测试被重复执行；
- 本地导出的源码包、npm 包和可执行构建统一放在 Git 忽略的 `outputs/` 目录；
- 每次项目修改同步更新 CHANGELOG，并提交到 Git。
