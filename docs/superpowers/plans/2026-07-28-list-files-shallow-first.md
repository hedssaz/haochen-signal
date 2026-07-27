# 文件列表浅层优先 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `list_files` 在 500 个文件上限内按深度优先保留浅层文件。

**Architecture:** 只修改 `collectRegularFiles` 的遍历策略：由递归深度优先改为逐层队列遍历。每层目录及文件保持完整相对路径字典序，现有边界、排除、取消和返回结构不变。

**Tech Stack:** TypeScript、Node.js `fs/promises`、Vitest

## Global Constraints

- 最多返回 500 个文件。
- 文件深度以请求目录为基准。
- 浅层优先，同一深度按完整相对路径字典序排列。
- 不增加依赖，不修改工具输入输出结构。

---

### Task 1: 浅层优先收集与文档

**Files:**
- Modify: `tests/tools/files.test.ts`
- Modify: `src/tools/files.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `collectRegularFiles(inputPath, context, signal, maxFiles)`
- Produces: 保持 `{files: string[]; truncated: boolean}` 不变

- [ ] **Step 1: 写失败测试**

更新稳定顺序断言为根目录文件先于嵌套文件，并新增：

```ts
it('keeps shallow files when deep files exceed the listing limit', async () => {
  await mkdir(join(workspace, 'deep', 'nested'), {recursive: true});
  await writeFile(join(workspace, 'z-root.txt'), 'root');
  await Promise.all(Array.from({length: 500}, (_, index) =>
    writeFile(
      join(workspace, 'deep', 'nested', `${String(index).padStart(3, '0')}.txt`),
      'x',
    ),
  ));

  const result = await listFiles({}, context, signal);

  expect(result.truncated).toBe(true);
  expect(result.data?.files).toHaveLength(500);
  expect(result.data?.files[0]).toBe('z-root.txt');
});
```

把原边界测试改为：

```ts
it.each([
  [500, false],
  [501, true],
])('lists at most 500 of %i files and reports truncation as %s', async (
  count,
  truncated,
) => {
  await Promise.all(Array.from({length: count}, (_, index) =>
    writeFile(join(workspace, `${String(index).padStart(3, '0')}.txt`), 'x'),
  ));

  const result = await listFiles({}, context, signal);

  expect(result.data?.files).toHaveLength(Math.min(count, 500));
  expect(result.truncated).toBe(truncated);
});
```

新增同层跨目录排序测试：

```ts
it('orders files at the same depth by complete relative path', async () => {
  await mkdir(join(workspace, 'b'));
  await mkdir(join(workspace, 'a'));
  await writeFile(join(workspace, 'b', 'a.txt'), 'b');
  await writeFile(join(workspace, 'a', 'z.txt'), 'a');

  const result = await listFiles({}, context, signal);

  expect(result.data?.files).toEqual(['a/z.txt', 'b/a.txt']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/tools/files.test.ts`

Expected: FAIL；嵌套路径仍按全局字典序出现在根目录文件之前，或浅层文件被 500 个深层文件挤出。

- [ ] **Step 3: 实现最小改动**

把递归 `walk` 和最终全局排序替换为逐层目录队列：

```ts
let directories = [root];
while (directories.length > 0) {
  const nextDirectories: ResolvedPath[] = [];
  directories.sort((left, right) =>
    comparePaths(left.relative, right.relative));
  for (const directory of directories) {
    assertNotAborted(signal);
    const entries = await readdir(directory.absolute, {withFileTypes: true});
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      assertNotAborted(signal);
      if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) {
        continue;
      }
      const requested = directory.relative === '.'
        ? entry.name
        : join(directory.relative, entry.name);
      const resolved = await resolveWorkspacePath(
        context.workspace,
        requested,
        'existing',
      );
      const stat = await lstat(resolved.absolute);
      if (stat.isDirectory()) {
        nextDirectories.push(resolved);
      } else if (stat.isFile()) {
        if (files.length >= maxFiles) {
          return {files, truncated: true};
        }
        files.push(toWorkspacePath(resolved.relative));
      }
    }
  }
  directories = nextDirectories;
}
return {files, truncated: false};
```

删除最终全局路径排序，避免破坏“深度优先级”；每层本身已确定性排序。

- [ ] **Step 4: 运行目标测试确认通过**

Run: `npm test -- tests/tools/files.test.ts`

Expected: PASS。

- [ ] **Step 5: 更新中文文档**

README 说明 500 上限采用浅层优先截断；CHANGELOG 在“修复”下记录大型目录不再挤掉浅层入口文件。

- [ ] **Step 6: 完整验证**

Run: `npm test && npm run typecheck && npm run build && git diff --check`

Expected: 全部命令退出码为 0。

- [ ] **Step 7: 提交**

```bash
git add src/tools/files.ts tests/tools/files.test.ts README.md CHANGELOG.md
git commit -m "fix: 文件列表优先保留浅层文件"
```
