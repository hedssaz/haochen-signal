# 最终功能修复报告

## 结论与提交

最终审查提出的 4 项 Important 与 2 项 Minor 已全部修复。实现、测试与中文文档提交：

```text
d5c7e70908f8746e87e3ad643658a252af9255de
```

本报告单独提交，以便正文引用稳定的实现提交哈希。

## 1. 模型配置面板两阶段 Ctrl+C

### RED

先增加状态控制器、discovering/saving 回退以及 App 两阶段退出回归：

```text
npx vitest run tests/cli/model-config.test.ts tests/cli/model-config-view.test.tsx
```

结果：退出码 1；2 个文件中 7 项按预期失败、13 项通过。失败包括：

- `ModelConfigOperationController` 尚不存在；
- discovering 无统一 abort/status；
- saving 不能返回提交前的可编辑页面；
- App 面板仍在全局 Ctrl+C 处理前直接返回。

App 精确竞态命令：

```text
npx vitest run tests/cli/app.test.tsx
```

结果：退出码 1；44 项中 3 项失败、41 项通过，其中 discovery 与 saving 两项分别证明 signal 未被 abort；第三项为 usage 回归的初始用例。

### GREEN

实现统一 `ModelConfigOperationController`，公开 `status`、`begin`、`abort`、`isCurrent`、`complete`；发现与保存均获得独立 signal。App 先处理 Ctrl+C，再决定是否屏蔽模型面板的普通输入：

- discovering 第一次 Ctrl+C abort 并回 `provider_actions`；
- saving 第一次 Ctrl+C abort 并回 `pendingSave.returnScreen`；
- 操作尚在收尾时第二次 Ctrl+C 保存并退出；
- operation 已 settle 后，面板空闲 Ctrl+C 仍按空闲退出；
- ModelConfigView 不再自行消费 Ctrl+C，避免双重状态转换。

验证：

```text
npx vitest run tests/cli/model-config.test.ts tests/cli/model-config-view.test.tsx tests/cli/app.test.tsx
```

结果：退出码 0；3 个文件、64 项全部通过。

## 2. write_file 在 link 期间取消

### RED

增加受控硬链接延迟和他人替换目标两个竞态：

```text
npx vitest run tests/tools/files.test.ts -t "after link|replacement target"
```

结果：退出码 1；2 项均失败。原实现均返回 `ok: true`，证明最后一次取消检查位于 `link()` 之前。

### GREEN

`executeAdd` 在 `link()` 返回后再次检查 signal。若已经取消，则比较临时文件与目标文件的 `dev/ino` 身份并再次复核：

- 目标仍是本次创建的硬链接时，unlink 目标并清理临时文件；
- 目标已被其他参与者替换时，不删除替换文件；
- 两种路径都返回真实 `ABORTED`。

再次运行同一命令：退出码 0；2 项通过、其余 53 项按过滤条件跳过。

## 3. taskSessionId 中断 writer 生命周期

### RED

入口测试要求 writer 在凭据解析前绑定 taskSessionId、同一任务幂等写入、任务结束后清除：

```text
npx vitest run tests/cli/index.test.ts -t "binds interruption"
```

结果：退出码 1；`createTaskInterruptionRouter` 为 `undefined`。

### GREEN

新增 `createTaskInterruptionRouter`：

- `beginTask(taskSessionId)` 在 `resolveModelRuntime(signal)` 前调用；
- 当前任务的 `appendInterrupted` 固定写入捕获的 taskSessionId，重复调用复用同一 Promise；
- `finally` 的 `finish()` 只清理自己的 writer，不会清掉后来任务的 writer；
- 无活动任务时 `appendCurrent` 使用最新 clear/resume 后的 sessionId。

入口验证同一命令退出码 0；1 项通过。另加等待隐藏凭据时连续两次 Ctrl+C 的 App 集成验证：

```text
npx vitest run tests/cli/app.test.tsx -t "credential-wait interruption"
```

结果：退出码 0；1 项通过，唯一 interrupted 事件写入 `task-session`，不会写入模拟恢复后的 `resumed-session`。

## 4. 向现有 provider 添加第二模型

### RED

与第 1、5 项一起运行状态/视图测试时，新增路径按预期失败：

```text
npx vitest run tests/cli/model-config.test.ts tests/cli/model-config-view.test.tsx
```

结果：退出码 1；7 项失败、13 项通过。`A` 仍直接进入新供应商名称输入，无法选择当前供应商，保存逻辑也总是追加新 provider。

### GREEN

新增 `add_actions`：

- 有选中模型时，`A` 显示“添加到当前供应商 / 添加新供应商 / 取消”；
- 当前供应商路径保存 `targetProviderId`，复用原 provider 与 baseUrl；
- GET models 复用进程临时 Key、专属环境变量、Keychain 或可取消的 Ink 隐藏输入；
- 手动 Model ID 不要求重新输入 Key；
- 保存只向当前 provider 的 models 追加新模型，不追加重复 provider。

同一状态/视图命令退出码 0；20/20 通过。App 的 discovery 两阶段回归同时走过“添加到当前供应商”路径。

## 5. 显示 provider 专属环境变量

### RED

状态/视图 RED 中，provider action 页只显示名称与 baseUrl，断言找不到：

```text
HAOCHEN_PROVIDER_0064006500650070007300650065006B_API_KEY
```

### GREEN

provider action 页使用 `providerApiKeyEnvironmentVariable(provider.id)` 显示实际专属变量名；新 provider 与现有 provider 均由同一 provider 推导函数提供信息。状态/视图测试 20/20 通过。

## 6. 删除模型后清理 usageByModelId

### RED

为确认回归断言确实锁住 stale usage，临时移除过滤逻辑后运行：

```text
npx vitest run tests/cli/app.test.tsx -t "drops deleted model usage"
```

结果：退出码 1；重新添加相同本地 ID 后实际显示 `上下文 15 / 128k`，期望 `上下文 0 / 128k`。

### GREEN

恢复实现：每次配置保存成功时，以新 config 的模型 ID 集合过滤 `usageByModelId`。再次运行同一命令：退出码 0；1 项通过，重新添加相同本地 ID 后显示 0。

## 聚焦回归

```text
npx vitest run \
  tests/cli/model-config.test.ts \
  tests/cli/model-config-view.test.tsx \
  tests/cli/app.test.tsx \
  tests/cli/index.test.ts \
  tests/tools/files.test.ts \
  tests/agent/loop.test.ts
```

结果：退出码 0；6 个文件、168 项全部通过。新增凭据等待集成用例后，App 单文件为 45 项。

## 全量验证

### 测试

沙箱内首次 `npm test`：退出码 1；41 个文件中 2 个集成文件因 `listen EPERM: operation not permitted 127.0.0.1` 失败，业务测试 698 项通过。

允许本机临时回环端口后重跑同一命令：

```text
npm test
```

结果：退出码 0；41 个测试文件、703 项全部通过。

### 类型、构建与发布入口

```text
npm run typecheck
npm run build
node dist/cli.mjs --version
node dist/haochen-onefile.mjs --version
git diff --check
```

结果：

- typecheck：退出码 0；
- build：退出码 0；
- 两个版本入口均输出 `0.1.0`；
- `git diff --check`：退出码 0。

## 自审

- Ctrl+C 由 App 单点编排，ModelConfigView 不再与 App 同时处理同一按键。
- operation controller 以 signal 身份拒绝旧 Promise 的迟到结果；Esc 取消会 abort 并清除活动槽，新操作不会被旧 finally 清掉。
- 现有 provider 的手动添加路径不会读取或保存新 Key；GET 路径仍通过同一个可取消凭据 broker，Key 不进入配置、会话或错误文本。
- provider 保存逻辑只在 `targetProviderId` 为空时追加 provider；现有 provider 路径保持 providers 数组不变。
- usage 过滤仅删除配置中已经不存在的本地模型 ID，不改动仍存在模型的真实最近 usage。
- write_file 把硬链接调用视为不可逆提交点，发布开始后不再尝试 unlink 目标；代理循环会等待变更工具结束并先记录真实结果。
- task interruption router 对每个任务幂等，使用函数身份保护清理；旧任务迟到的 finish 不会清除新任务 writer。
- README 与 CHANGELOG 均已用中文同步更新；未写入凭据、构建产物或无关重构。

## 关注点

无遗留 blocker。全量集成测试需要允许绑定本机临时回环端口；获准后同一测试命令 703/703 通过。

## 最终复审追加修复

### 1. 模型配置保存取消与乱序

RED 新增两层回归：

- `saveConfig` 在临时文件写完、目标重命名前收到取消时必须抛出 `AbortError`，不得调用 `rename`，并清理未发布临时文件；
- 保存 A 已开始后取消，再提交 B 时必须串行等待 A 收尾；即使 A 忽略取消并晚返回，最终磁盘与运行时都只能是 B。

聚焦 RED 结果：退出码 1；`saveConfig` 仍完成重命名，CLI 保存器尚不存在。

GREEN 实现：

- `saveConfig` 接收 `AbortSignal`，在创建目录前、写临时文件前和 `rename` 前检查取消；
- `createLatestModelConfigSaver` 以 Promise 尾链串行保存，并以单调代际阻止旧请求提交运行时状态；
- App 保留 signal 身份保护，补充 A 取消、B 成功、A 晚返回后界面仍保持 B 的回归。

### 2. write_file 不可逆提交点

RED 将原回滚断言改为提交点契约：

- `link` 已发布但尚未返回时取消，工具最终必须返回真实成功并保留目标；
- `link` 开始后不得对已发布目标调用 `unlink`；
- 代理循环在变更工具执行期间取消时，必须先发出并持久化工具成功，再发出中断，且模型只收到一轮请求。

聚焦 RED 结果：退出码 1；工具仍把发布成功误报为取消，代理循环也会先结束而看不到工具结果。

GREEN 实现：

- 删除发布后的 `lstat + unlink` 回滚路径，最后一次取消检查停在 `link` 调用之前；
- 主循环对 `write_file` 与 `apply_patch` 等待真实执行结果，取消已发生时直接持久化工具事件，再进入统一中断出口；
- 不构造下一轮 tool message/model request。

聚焦 GREEN：

```text
npx vitest run tests/config/load.test.ts tests/cli/index.test.ts \
  tests/agent/loop.test.ts tests/tools/files.test.ts \
  -t "cancels before rename|serializes model config saves|waits for a mutating tool|link publication|never attempts to unlink"
```

结果：退出码 0；4 个文件、5 项通过。

UI 乱序回归：

```text
npx vitest run tests/cli/app.test.tsx -t "ignores a canceled save"
```

结果：退出码 0；1 项通过。

相关文件全量回归：

```text
npx vitest run tests/config/load.test.ts tests/cli/index.test.ts \
  tests/cli/model-config.test.ts tests/cli/app.test.tsx \
  tests/agent/loop.test.ts tests/tools/files.test.ts \
  tests/tools/registry.test.ts
```

结果：退出码 0；7 个文件、243 项全部通过。

最终完整验证：

```text
npm test
npm run typecheck
npm run build
node dist/cli.mjs --version
node dist/haochen-onefile.mjs --version
git diff --check
```

结果：

- 全量测试退出码 0；41 个测试文件、707 项全部通过；
- typecheck 与 build 均退出码 0；
- 两个发布入口均输出 `0.1.0`；
- `git diff --check` 退出码 0。

最终自审确认：配置保存的取消检查位于 `rename` 前，保存尾链保证最终磁盘顺序，代际检查保证运行时与 UI 只接受最新请求；文件发布后不存在任何目标路径回滚，变更工具中止顺序为真实工具结果、持久化工具事件、中断事件，且不会发起下一轮模型请求。无遗留 blocker。

## 最后 P1：配置 rename 提交点

### 根因与 RED

`saveConfig` 已经把最后一次 signal 检查放在 `rename` 之前，重命名成功后会正常 resolve；但保存队列在 `persist` resolve 后再次执行 `signal.throwIfAborted()`，App 的成功分支也再次拒绝 aborted signal。结果是取消发生在 `rename` 调用之后时，磁盘已经提交 A，运行时与 UI 却仍停留在旧配置。

新增受控 deferred rename 回归：

- 无 B：A 进入 `rename` 后取消，随后 `rename` 成功；要求 disk/runtime/UI 全部接纳 A；
- 有 B：A 进入 `rename` 后取消并提交，B 排队保存；要求最终 disk/runtime/UI 全部为 B。

RED：

```text
npx vitest run tests/cli/index.test.ts tests/cli/app.test.tsx \
  -t "commits runtime state when cancellation arrives after config rename starts|applies a save that commits after cancellation"
```

结果：退出码 1；2 项失败。保存队列以 `AbortError` 拒绝已经提交的 A，App 未调用 active-model 更新。

### GREEN

- 保存队列仅在持久化开始前响应 signal；`persist` 成功 resolve 后视为已越过提交点，不再以 aborted signal 否定提交；
- 持久化成功后仍检查 generation，有 B 取代时 A 不更新运行时；
- App 成功分支只检查操作 signal 是否仍为当前代际，不再把当前但 aborted 的已提交保存丢弃；
- `save_succeeded` 可在 Ctrl+C 已把面板退回编辑页后重新协调 committed config，并回到模型列表。

聚焦验证：

```text
npx vitest run tests/cli/index.test.ts tests/cli/app.test.tsx \
  -t "commits runtime state when cancellation arrives after config rename starts|applies a save that commits after cancellation|serializes model config saves|ignores a canceled save"
```

结果：退出码 0；2 个文件、4 项全部通过。

相关回归：

```text
npx vitest run tests/config/load.test.ts tests/cli/model-config.test.ts \
  tests/cli/index.test.ts tests/cli/app.test.tsx
```

结果：退出码 0；4 个文件、129 项全部通过。

最终验证：

```text
npm test
npm run typecheck
npm run build
git diff --check
```

结果：全量测试退出码 0，41 个测试文件、709 项全部通过；typecheck 与 build 均退出码 0；最终差异检查通过。

## 最后 P1：B 请求但取消或失败

### 根因与 RED

保存队列在“请求 B”时立即递增 `latestGeneration`，导致已进入 A rename 的持久化虽然成功，A 的全局 commit 仍被代际检查拒绝。若 B 随后在开始前取消或持久化失败，磁盘停在 A，`activeConfig` 与 UI 却停在旧配置。

新增两组 deferred 回归，各覆盖 B 开始前取消与 B persist reject：

- 队列层要求 A 成功 Promise、磁盘 A、全局 runtime A；
- App 层要求最新 committed config 为 A，回调与当前标记均协调到 A。

RED：

```text
npx vitest run tests/cli/index.test.ts tests/cli/app.test.tsx \
  -t "keeps committed A when queued B|reconciles the UI to committed A"
```

结果：退出码 1；4 项全部失败。A 已写盘，但 saver 以“被更新操作取代”的 `AbortError` 拒绝 A，运行时和 UI 都仍为旧配置。

### GREEN

- 保存队列继续严格串行，但移除请求时的全局代际抢占；每次 `persist` 成功都按顺序调用 commit；
- B 成功时提交顺序为 A、B，最终三层均为 B；B 取消或失败时最后成功提交仍为 A；
- controller 提供当前 committed config 只读快照；
- App 仍以当前 signal 身份阻止旧 Promise 直接覆盖 B 编辑状态；当前 B 失败或取消时读取 committed A，通过 `reconcile_committed` 同步配置、活动模型与光标，真实失败同时保留错误信息。

聚焦验证：

```text
npx vitest run tests/cli/index.test.ts tests/cli/app.test.tsx \
  -t "serializes model config saves|commits runtime state when cancellation|applies a save that commits|ignores a canceled save|keeps committed A|reconciles the UI"
```

结果：退出码 0；2 个文件、8 项全部通过。

最终验证：

- 相关回归：4 个文件、133 项全部通过；
- 全量测试：41 个文件、713 项全部通过；
- `npm run typecheck` 与 `npm run build` 均退出码 0；
- `git diff --check` 通过。
