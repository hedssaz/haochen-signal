# Task 5：`/model` 独立配置界面报告

## 完成内容

- 新增纯状态机 `src/cli/model-config.ts`：
  - 模型列表跨供应商方向键导航、Enter 切换；
  - `A` 添加、`E` 编辑、`D` 删除、`Esc` 返回；
  - 供应商名称、API 地址、隐藏 API Key 向导；
  - 获取模型、稳定去重排序选择、手动 Model ID；
  - 只读 Model ID、默认显示名、默认 `128000` 上下文；
  - 保存前不修改内存配置，失败保留原配置与表单；
  - 保存 effect 单独携带临时凭据，v2 配置不包含 API Key。
- 新增独立 Ink 视图 `src/cli/model-config-view.tsx`：
  - 普通输入、转录、底栏和命令建议在面板内全部隐藏；
  - 分组模型列表、当前标记、空状态、向导、发现选择和详情页；
  - API Key 只显示等长圆点。
- `App` 新增可注入 `ModelConfigController`：
  - `discover` 接收供应商、临时 Key 和取消信号；
  - `save` 接收待原子保存的 v2 配置和可选临时凭据；
  - 保存成功后才切换内存配置；
  - 当前模型最大上下文立即更新；
  - 最近真实 usage 按稳定模型 profile ID 隔离。
- CLI 入口接通现有 `discoverModels`、`saveConfig` 和供应商专属 Keychain：
  - macOS 先保存供应商专属 Keychain，再原子保存配置；
  - Linux/Windows 的新增供应商 Key 只进入当前进程 Map；
  - 配置写入完成后才替换入口内存配置。
- OpenAI-compatible client 增加 v2 活动模型/供应商配置兼容入口，仍保留显式 endpoint 配置接口。
- `/model` 命令帮助、README 与 CHANGELOG 已改为中文独立面板说明。

## TDD 证据

先新增并运行失败测试：

```text
tests/cli/model-config.test.ts：模块不存在
tests/cli/model-config-view.test.tsx：模块不存在
tests/cli/app.test.tsx：/model 仍显示旧“当前模型”提示
```

实现后聚焦验证：

```text
npx vitest run tests/cli/model-config.test.ts \
  tests/cli/model-config-view.test.tsx \
  tests/cli/app.test.tsx \
  tests/cli/commands.test.ts

Test Files  4 passed (4)
Tests       61 passed (61)
```

构建验证：

```text
npm run build
exit 0
```

全量测试审计：

```text
npm test
Test Files  4 failed | 36 passed (40)
Tests       14 failed | 667 passed (681)
```

14 个失败均位于 Task 5 之外：3 个首次配置测试仍断言旧版扁平配置，7 个模型客户端测试在 v2 Schema 已禁止认证 Header 后仍尝试把认证 Header 放进旧配置，4 个本地 HTTP 集成测试因受限沙箱 `listen EPERM` 无法监听 `127.0.0.1`。

## 范围边界与顾虑

- 未实现 Task 6 的无模型启动、未绑定时普通输入拦截、按供应商动态重建/复用客户端。
- 当前入口在进程启动时仍绑定初始供应商 client；跨供应商切换后的下一轮动态 client 由 Task 6 完成。
- 全量 `npm run typecheck` 只剩既有 `tests/cli/first-run.test.ts` 仍按旧配置读取 `config.baseUrl` 的错误；该测试和首次启动流程属于 Task 6。
- 按 `requesting-code-review` 技能尝试启动只读审查代理，但当前线程并发槽已满；已自行逐项核对凭据泄漏、保存失败、异步取消、输入冲突和 Task 6 边界。

## P2 审查修复

审查发现 `config.models` 交错排列供应商时，视图会按供应商分组重排，状态机却仍按原数组索引导航。例如 `[A1, B1, A2]` 显示为 `[A1, A2, B1]`，按一次 `↓` 的光标和 Enter 切换目标不一致。

- 新增共享 `orderedModels(config)`，唯一规定“稳定供应商顺序 × 各组原 `models` 顺序”；
- 状态机的初始活动索引、选中模型、方向键移动和保存后索引恢复全部使用共享序列；
- 视图分组渲染及选择光标同样使用共享序列索引；
- 新增交错数组的共享顺序、上下移动、Enter 切换和渲染一致性回归测试。
