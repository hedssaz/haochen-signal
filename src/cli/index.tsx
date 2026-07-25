#!/usr/bin/env node
import process from 'node:process';
import {mkdir} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {render} from 'ink';
import {z} from 'zod';
import {runAgentTask} from '../agent/loop.js';
import {compactHistory} from '../agent/context.js';
import {loadConfig, saveConfig} from '../config/load.js';
import {getAppPaths} from '../config/paths.js';
import {readMacOsKeychain, saveMacOsKeychain} from '../config/credentials.js';
import {createOpenAiCompatibleClient} from '../providers/openai-compatible.js';
import {classifyOperation} from '../security/boundary.js';
import {reviewOperation} from '../security/reviewer.js';
import {AuditStore, workspaceId} from '../sessions/audit.js';
import {createSessionId, SessionStore} from '../sessions/store.js';
import {createSerializedSessionStore} from '../sessions/serialized-store.js';
import {ToolRegistry} from '../tools/registry.js';
import type {ToolDefinitionSpec} from '../tools/types.js';
import {listFiles, searchText, readFileTool, applyPatch} from '../tools/files.js';
import {runCommand} from '../tools/command.js';
import {gitStatus, gitDiff, gitLog} from '../tools/git.js';
import {webSearch, webFetch} from '../tools/web.js';
import {App} from './app.js';
import {InteractiveConfirmationBroker} from './confirmation.js';
import {runFirstRunWithCredentials} from './first-run.js';
import {credentialSaverForPlatform, resolveUserHome} from './platform.js';
import {createFirstRunInput} from './terminal-input.js';
import {resolveStartupApiKey} from './startup-credentials.js';
import {clearTerminalScreen} from './terminal-screen.js';
import {GateReporter} from './gate-reporter.js';
import {CLI_NAME, PRODUCT_ENGLISH_NAME, PRODUCT_NAME, VERSION} from '../meta.js';

const args = new Set(process.argv.slice(2));

function showHelp(): void {
  process.stdout.write(`${PRODUCT_NAME} · ${PRODUCT_ENGLISH_NAME}\n\nUsage: ${CLI_NAME} [--help] [--version]\n`);
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {type: 'object', properties, required, additionalProperties: false};
}

export function toolDefinitions(): Map<string, ToolDefinitionSpec<unknown, unknown>> {
  const specs: ToolDefinitionSpec<unknown, unknown>[] = [
    {name: 'list_files', description: '列出工作区文件', inputSchema: z.object({path: z.string().optional()}).strict(), jsonSchema: objectSchema({path: {type: 'string'}}), execute: (i, c, s) => listFiles(i as {path?: string}, c, s)},
    {name: 'search_text', description: '搜索工作区文本', inputSchema: z.object({query: z.string(), path: z.string().optional(), maxMatches: z.number().int().optional()}).strict(), jsonSchema: objectSchema({query: {type: 'string'}, path: {type: 'string'}, maxMatches: {type: 'integer'}}, ['query']), execute: (i, c, s) => searchText(i as {query: string; path?: string; maxMatches?: number}, c, s)},
    {name: 'read_file', description: '读取工作区文本文件；续读时保持 path、startLine、endLine 与上一页一致，并将上一页 nextCharacter 作为 startCharacter', inputSchema: z.object({path: z.string(), startLine: z.number().int().optional(), endLine: z.number().int().optional(), startCharacter: z.number().int().min(0).optional(), maxCharacters: z.number().int().min(1).max(65_536).optional()}).strict(), jsonSchema: objectSchema({path: {type: 'string'}, startLine: {type: 'integer'}, endLine: {type: 'integer'}, startCharacter: {type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER}, maxCharacters: {type: 'integer', minimum: 1, maximum: 65_536}}, ['path']), execute: (i, c, s) => readFileTool(i as {path: string; startLine?: number; endLine?: number; startCharacter?: number; maxCharacters?: number}, c, s)},
    {name: 'apply_patch', description: '通过结构化补丁修改工作区文件', inputSchema: z.object({operations: z.array(z.discriminatedUnion('type', [z.object({type: z.literal('add'), path: z.string(), content: z.string()}).strict(), z.object({type: z.literal('update'), path: z.string(), expected: z.string(), replacement: z.string()}).strict(), z.object({type: z.literal('delete'), path: z.string(), sha256: z.string()}).strict()]))}).strict(), jsonSchema: objectSchema({operations: {type: 'array'}}, ['operations']), execute: (i, c, s) => applyPatch(i as never, c, s)},
    {name: 'run_command', description: '执行前台命令', inputSchema: z.object({command: z.string(), args: z.array(z.string()).optional(), cwd: z.string().optional(), shell: z.boolean().optional(), timeoutMs: z.number().int().optional(), maxOutputBytes: z.number().int().optional()}).strict(), jsonSchema: objectSchema({command: {type: 'string'}, args: {type: 'array', items: {type: 'string'}}, cwd: {type: 'string'}, shell: {type: 'boolean'}, timeoutMs: {type: 'integer'}, maxOutputBytes: {type: 'integer'}}, ['command']), execute: (i, c, s) => runCommand(i as never, c, s)},
    {name: 'git_status', description: '读取 Git 状态', inputSchema: z.object({}).strict(), jsonSchema: objectSchema({}), execute: (_i, c, s) => gitStatus(c, s)},
    {name: 'git_diff', description: '读取 Git 差异', inputSchema: z.object({staged: z.boolean().optional()}).strict(), jsonSchema: objectSchema({staged: {type: 'boolean'}}), execute: (i, c, s) => gitDiff(i as {staged?: boolean}, c, s)},
    {name: 'git_log', description: '读取近期 Git 记录', inputSchema: z.object({limit: z.number().int().optional()}).strict(), jsonSchema: objectSchema({limit: {type: 'integer'}}), execute: (i, c, s) => gitLog(i as {limit?: number}, c, s)},
    {name: 'web_search', description: '搜索公开技术资料', inputSchema: z.object({query: z.string(), limit: z.number().int().min(1).max(10).optional()}).strict(), jsonSchema: objectSchema({query: {type: 'string'}, limit: {type: 'integer', minimum: 1, maximum: 10}}, ['query']), execute: (i, c, s) => webSearch(i as {query: string; limit?: number}, c, s)},
    {name: 'web_fetch', description: '提取公开网页正文', inputSchema: z.object({url: z.string()}).strict(), jsonSchema: objectSchema({url: {type: 'string'}}, ['url']), execute: (i, c, s) => webFetch(i as {url: string}, c, s)},
  ];
  return new Map(specs.map(spec => [spec.name, spec]));
}

async function main(): Promise<void> {
  if (args.has('--version') || args.has('-v')) { process.stdout.write(`${VERSION}\n`); return; }
  if (args.has('--help') || args.has('-h')) { showHelp(); return; }
  const paths = getAppPaths(
    process.env,
    resolveUserHome(process.env, homedir()),
  );
  let config = await loadConfig(paths.configFile);
  let apiKey: string | undefined;
  if (config === undefined) {
    const input = createFirstRunInput(process.stdin, process.stdout);
    try {
      const created = await runFirstRunWithCredentials(input, {
        write: text => process.stdout.write(text),
        saveKey: credentialSaverForPlatform(
          process.platform,
          saveMacOsKeychain,
        ),
      });
      config = created.config; apiKey = created.apiKey; await saveConfig(paths.configFile, config);
    } finally { input.close(); }
  }
  if (config === undefined) throw new Error('无法创建配置。');
  let activeConfig = config;
  apiKey ??= await resolveStartupApiKey({
    env: process.env,
    readKeychain: readMacOsKeychain,
    createInput: () => createFirstRunInput(process.stdin, process.stdout),
    write: text => process.stdout.write(text),
  });
  if (!apiKey) throw new Error('未提供 API Key；请设置 HAOCHEN_API_KEY 或重新首次配置。');
  const workspace = process.cwd();
  const currentWorkspaceId = workspaceId(workspace);
  const tempDir = join(tmpdir(), 'haochen'); await mkdir(tempDir, {recursive: true});
  const model = createOpenAiCompatibleClient(activeConfig, apiKey);
  const store = new SessionStore(paths.sessionsDir); const sessionStore = createSerializedSessionStore(store); const audit = new AuditStore(paths.auditDir); const grants = new Set<string>();
  const confirmations = new InteractiveConfirmationBroker(
    process.stdin.isTTY === true && process.stdout.isTTY === true,
  );
  const registry = new ToolRegistry({tools: toolDefinitions(), classify: classifyOperation, review: reviewOperation, confirm: request => confirmations.request(request), sessionGrants: grants, audit});
  const gateReporter = new GateReporter();
  let sessionId = createSessionId();
  await store.initialize(sessionId, currentWorkspaceId);
  let activeInterruptionWriter: ((reason: string) => Promise<void>) | undefined;
  clearTerminalScreen(process.stdout);
  const instance = render(<App
    workspace={workspace} sessionId={sessionId} model={activeConfig.model} contextTokens={activeConfig.contextWindow} sessionGrants={grants}
    workspaceId={currentWorkspaceId}
    runTask={(task, signal) => {
      const taskSessionId = sessionId;
      let interruptedWrite: Promise<void> | undefined;
      const appendInterrupted = (reason: string): Promise<void> => {
        interruptedWrite ??= sessionStore.append(taskSessionId, {
          type: 'interrupted', at: Date.now(), reason,
        });
        return interruptedWrite;
      };
      activeInterruptionWriter = appendInterrupted;
      return runAgentTask({task, model, modelName: activeConfig.model, registry, session: {id: taskSessionId, store: sessionStore}, workspace, tempDir, reviewClient: model, reviewModel: activeConfig.reviewModel ?? activeConfig.model, limits: {maxTurns: 16, maxToolCalls: 32}, signal, maxContextTokens: activeConfig.contextWindow, appendInterrupted, reportGate: event => gateReporter.report(event)});
    }}
    executeTool={(name, input, signal) => registry.execute(name, input, {workspace, tempDir, taskSummary: '执行本地斜杠命令', reviewClient: model, reviewModel: activeConfig.reviewModel ?? activeConfig.model, signal, reportGate: event => gateReporter.report(event)})}
    compact={async () => { const events = await sessionStore.read(sessionId).catch(() => []); const result = await compactHistory(events, async prompt => { let text = ''; for await (const event of model.stream({model: activeConfig.model, messages: [{role: 'user', content: prompt}], toolChoice: 'none'}, new AbortController().signal)) if (event.type === 'text_delta') text += event.text; return text; }); if (result.compacted) { await sessionStore.append(sessionId, result.summaryEvent); return {ok: true, message: '已压缩历史。'}; } return {ok: false, message: result.reason}; }}
    saveSession={async reason => { await sessionStore.append(sessionId, {type: 'checkpoint', at: Date.now(), reason}); }} appendInterrupted={async reason => {
      if (activeInterruptionWriter !== undefined) return activeInterruptionWriter(reason);
      await sessionStore.append(sessionId, {type: 'interrupted', at: Date.now(), reason});
    }} createSession={async () => {
      const nextSessionId = createSessionId();
      await store.initialize(nextSessionId, currentWorkspaceId);
      sessionId = nextSessionId;
      return sessionId;
    }} listSessions={() => store.list()} resumeSession={async id => { await sessionStore.read(id); sessionId = id; return {id, message: `已恢复会话：${id}`}; }} onModelChange={next => { activeConfig = {...activeConfig, model: next}; }} onExit={async () => undefined} confirmation={confirmations} gateReporter={gateReporter}
  />);
  await instance.waitUntilExit();
}

void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
