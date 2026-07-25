# 浩宸信号跨平台与 GitHub 公开发布设计

日期：2026-07-26

## 目标

将“浩宸信号”作为公开恶搞项目发布到 `hedssaz/haochen-signal`，同时确保 README 不会让读者误认为它适合真实开发，并用可验证的最小改动补齐 macOS、Linux 与 Windows 支持。

## 发布边界

- GitHub 仓库为公开仓库，默认分支为 `main`。
- 本次只推送源码和文档，不创建 GitHub Release，不发布 npm 包。
- README 顶部必须出现醒目的中文与英文警告，明确说明：
  - 项目为纯恶搞和实验用途；
  - 不保证正确性、安全性、数据完整性或兼容性；
  - 不应处理生产项目、重要代码、真实凭据或不可恢复的数据。
- `package.json`、仓库名、分支名和文档中不引入与项目无关的产品或模型品牌。

## 跨平台运行设计

### 用户目录与配置路径

入口使用 Node.js `os.homedir()` 作为用户目录的可靠默认值，不再在 `HOME` 缺失时回退到当前工作区。

配置、会话与审计路径继续由统一路径模块生成：

- macOS/Linux 在未设置 XDG 变量时使用用户目录下的标准隐藏目录；
- Windows 在未设置 XDG 变量时使用用户目录下的等价隐藏目录；
- 用户显式设置绝对 XDG 路径时，三个系统都继续尊重该设置。

本次不新增额外迁移器，避免改变现有用户的数据位置。

### API Key

- macOS：继续支持 `HAOCHEN_API_KEY`、macOS Keychain 和本次临时输入。
- Linux/Windows：支持 `HAOCHEN_API_KEY` 和本次临时输入。
- 仅在 macOS 显示“保存到系统钥匙串”流程。
- Linux/Windows 不将 API Key 明文写入项目配置或会话文件。
- README 分别给出 POSIX Shell 和 PowerShell 的临时环境变量示例。

### 终端与进程

- npm 全局安装生成的平台启动包装器仍是唯一正式启动方式。
- ANSI 清屏只在 TTY 中执行；Windows Terminal、PowerShell 与现代 `cmd.exe` 使用 Node/Ink 的现有终端能力。
- 保留现有 POSIX 进程组终止和 Windows `taskkill.exe` 进程树终止实现。
- 不为旧版 Windows 控制台或不支持 ANSI/TTY 的宿主增加专用界面。

## README 设计

README 顶部按以下顺序组织：

1. 红色感叹符风格的中文“纯恶搞”警告；
2. 对应英文警告；
3. 项目简介；
4. 三平台支持状态表；
5. macOS、Linux、Windows PowerShell 安装和配置示例；
6. 已有功能、权限审查和会话说明。

支持状态必须如实描述：

- macOS：自动化测试；可选 Keychain；
- Linux：自动化测试；环境变量或临时 Key；
- Windows：自动化测试；PowerShell 环境变量或临时 Key。

不使用“生产可用”“安全”“稳定”等无法证明的宣传措辞。

## 自动化验证

新增 GitHub Actions 工作流，在以下环境运行：

- `ubuntu-latest`
- `windows-latest`
- `macos-latest`

每个平台使用 Node.js 20，执行：

1. `npm ci`
2. `npm test`
3. `npm run typecheck`
4. `npm run build`
5. `node dist/cli.mjs --version`

本地新增或调整测试，覆盖：

- `HOME` 缺失时入口使用 `os.homedir()`；
- 非 macOS 首次配置不会询问保存 Keychain；
- macOS 仍保留 Keychain 保存流程；
- 平台相关说明与工作流矩阵存在。

由于当前开发机是 macOS，Windows/Linux 的最终执行证据以 GitHub Actions 矩阵结果为准。推送后必须等待全部任务完成；若任一平台失败，继续修复并推送，直到三平台全部通过。

## GitHub 发布流程

1. 在本地完成测试、类型检查和构建。
2. 更新中文 `README.md` 与 `CHANGELOG.md`。
3. 每组变更提交到 `main`。
4. 使用已登录的 GitHub 账号创建公开仓库 `hedssaz/haochen-signal`。
5. 将远程命名为 `origin`，推送 `main` 并设置上游。
6. 等待 GitHub Actions 三平台矩阵完成。
7. 核对公开仓库首页的警告、默认分支和 CI 状态。

## 不在本次范围

- npm Registry 发布；
- GitHub Release 或二进制附件；
- Windows Credential Manager；
- Linux Secret Service、KWallet 或 GNOME Keyring；
- WSL、旧版 Windows 控制台、移动终端的专项兼容；
- 对该恶搞项目作生产级支持承诺。

## 验收标准

- `https://github.com/hedssaz/haochen-signal` 可公开访问。
- README 首屏无需滚动即可看到中英文“纯恶搞、不要用于真实项目”警告。
- macOS、Linux 和 Windows 安装说明各自可复制执行。
- 非 macOS 不出现 macOS Keychain 保存问题。
- GitHub Actions 的 Ubuntu、Windows、macOS 任务全部通过。
- 本地工作区干净，最终提交已推送到 `origin/main`。
