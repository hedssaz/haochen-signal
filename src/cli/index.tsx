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
import type {
  HaochenConfig,
  ModelProfile,
  ProviderProfile,
} from '../config/schema.js';
import {getAppPaths} from '../config/paths.js';
import {readMacOsKeychain, saveMacOsKeychain} from '../config/credentials.js';
import {createOpenAiCompatibleClient} from '../providers/openai-compatible.js';
import {discoverModelsWithContext} from '../providers/model-discovery.js';
import {classifyOperation} from '../security/boundary.js';
import {reviewOperation} from '../security/reviewer.js';
import {AuditStore, workspaceId} from '../sessions/audit.js';
import {createSessionId, SessionStore} from '../sessions/store.js';
import {createSerializedSessionStore} from '../sessions/serialized-store.js';
import {ToolRegistry} from '../tools/registry.js';
import type {ToolDefinitionSpec} from '../tools/types.js';
import {
  applyPatch,
  listFiles,
  readFileTool,
  searchText,
  writeFile,
} from '../tools/files.js';
import {runCommand} from '../tools/command.js';
import {gitStatus, gitDiff, gitLog} from '../tools/git.js';
import {webSearch, webFetch} from '../tools/web.js';
import {
  WEB_SEARCH_QUERY_MAX_LENGTH,
  WEB_SEARCH_QUERY_PATTERN,
  WEB_SEARCH_RESULT_LIMIT_MAX,
} from '../tools/web-contract.js';
import {
  App,
  MODEL_NOT_BOUND_MESSAGE,
  type CompactResult,
} from './app.js';
import {InteractiveConfirmationBroker} from './confirmation.js';
import {InteractiveCredentialPromptBroker} from './credential-prompt.js';
import {createFirstRunConfig} from './first-run.js';
import {resolveUserHome} from './platform.js';
import {resolveStartupApiKey} from './startup-credentials.js';
import {clearTerminalScreen} from './terminal-screen.js';
import {GateReporter} from './gate-reporter.js';
import {CLI_NAME, PRODUCT_ENGLISH_NAME, PRODUCT_NAME, VERSION} from '../meta.js';
import type {ModelClient} from '../providers/types.js';
import type {SessionEvent} from '../sessions/types.js';
import {createTaskInterruptionRouter} from './task-interruption.js';
import {createLatestModelConfigSaver} from './model-config.js';

export {createTaskInterruptionRouter} from './task-interruption.js';
export {createLatestModelConfigSaver} from './model-config.js';

const args = new Set(process.argv.slice(2));
const MAX_AGENT_TURNS = 16;
const MAX_AGENT_TOOL_CALLS = 32;

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
    {name: 'write_file', description: '创建工作区内的新文件；目标已存在时拒绝覆盖', inputSchema: z.object({path: z.string(), content: z.string()}).strict(), jsonSchema: objectSchema({path: {type: 'string'}, content: {type: 'string'}}, ['path', 'content']), execute: (i, c, s) => writeFile(i as {path: string; content: string}, c, s)},
    {name: 'apply_patch', description: '通过结构化补丁修改工作区文件', inputSchema: z.object({operations: z.array(z.discriminatedUnion('type', [z.object({type: z.literal('add'), path: z.string(), content: z.string()}).strict(), z.object({type: z.literal('update'), path: z.string(), expected: z.string(), replacement: z.string()}).strict(), z.object({type: z.literal('delete'), path: z.string(), sha256: z.string()}).strict()]))}).strict(), jsonSchema: objectSchema({operations: {type: 'array'}}, ['operations']), execute: (i, c, s) => applyPatch(i as never, c, s)},
    {name: 'run_command', description: '执行前台命令', inputSchema: z.object({command: z.string(), args: z.array(z.string()).optional(), cwd: z.string().optional(), shell: z.boolean().optional(), timeoutMs: z.number().int().optional(), maxOutputBytes: z.number().int().optional()}).strict(), jsonSchema: objectSchema({command: {type: 'string'}, args: {type: 'array', items: {type: 'string'}}, cwd: {type: 'string'}, shell: {type: 'boolean'}, timeoutMs: {type: 'integer'}, maxOutputBytes: {type: 'integer'}}, ['command']), execute: (i, c, s) => runCommand(i as never, c, s)},
    {name: 'git_status', description: '读取 Git 状态', inputSchema: z.object({}).strict(), jsonSchema: objectSchema({}), execute: (_i, c, s) => gitStatus(c, s)},
    {name: 'git_diff', description: '读取 Git 差异', inputSchema: z.object({staged: z.boolean().optional()}).strict(), jsonSchema: objectSchema({staged: {type: 'boolean'}}), execute: (i, c, s) => gitDiff(i as {staged?: boolean}, c, s)},
    {name: 'git_log', description: '读取近期 Git 记录', inputSchema: z.object({limit: z.number().int().optional()}).strict(), jsonSchema: objectSchema({limit: {type: 'integer'}}), execute: (i, c, s) => gitLog(i as {limit?: number}, c, s)},
    {name: 'web_search', description: '搜索公开技术资料', inputSchema: z.object({query: z.string().trim().min(1).max(WEB_SEARCH_QUERY_MAX_LENGTH), limit: z.number().int().min(1).max(WEB_SEARCH_RESULT_LIMIT_MAX).optional()}).strict(), jsonSchema: objectSchema({query: {type: 'string', description: '去除首尾空白后的长度必须为 1 至 500 个字符', pattern: WEB_SEARCH_QUERY_PATTERN}, limit: {type: 'integer', minimum: 1, maximum: WEB_SEARCH_RESULT_LIMIT_MAX}}, ['query']), execute: (i, c, s) => webSearch(i as {query: string; limit?: number}, c, s)},
    {name: 'web_fetch', description: '提取公开网页正文', inputSchema: z.object({url: z.string()}).strict(), jsonSchema: objectSchema({url: {type: 'string'}}, ['url']), execute: (i, c, s) => webFetch(i as {url: string}, c, s)},
  ];
  return new Map(specs.map(spec => [spec.name, spec]));
}

export interface ConfigPersistence {
  load: (path: string) => Promise<HaochenConfig | undefined>;
  save: (path: string, config: HaochenConfig) => Promise<void>;
}

const defaultConfigPersistence: ConfigPersistence = {
  load: loadConfig,
  save: saveConfig,
};

export async function loadOrCreateConfig(
  path: string,
  dependencies: ConfigPersistence = defaultConfigPersistence,
): Promise<HaochenConfig> {
  const loaded = await dependencies.load(path);
  if (loaded !== undefined) return loaded;
  const created = createFirstRunConfig();
  await dependencies.save(path, created);
  return created;
}

export interface ModelRuntime {
  client: ModelClient;
  model: ModelProfile;
  provider: ProviderProfile;
}

export interface ModelClientFactoryOptions {
  provider: ProviderProfile;
  apiKey: string;
  timeoutMs: number;
}

export interface ModelRuntimeResolverOptions {
  getConfig: () => HaochenConfig;
  temporaryProviderKeys: Map<string, string>;
  resolveApiKey: (
    provider: ProviderProfile,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  createClient?: (options: ModelClientFactoryOptions) => ModelClient;
}

function providerClientCacheKey(
  provider: ProviderProfile,
  timeoutMs: number,
): string {
  return JSON.stringify({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    credentialRef: provider.credentialRef,
    headers: Object.entries(provider.headers).sort(
      ([left], [right]) => left.localeCompare(right),
    ),
    timeoutMs,
  });
}

export function createModelRuntimeResolver(
  options: ModelRuntimeResolverOptions,
): (signal?: AbortSignal) => Promise<ModelRuntime> {
  const clientCache = new Map<string, Map<string, ModelClient>>();
  const createClient = options.createClient ?? (request => (
    createOpenAiCompatibleClient({
      baseUrl: request.provider.baseUrl,
      headers: request.provider.headers,
      timeoutMs: request.timeoutMs,
    }, request.apiKey)
  ));

  return async signal => {
    signal?.throwIfAborted();
    const config = options.getConfig();
    const model = config.models.find(
      candidate => candidate.id === config.activeModelId,
    );
    if (model === undefined) throw new Error(MODEL_NOT_BOUND_MESSAGE);
    const provider = config.providers.find(
      candidate => candidate.id === model.providerId,
    );
    if (provider === undefined) {
      throw new Error('当前模型的供应商不存在。');
    }

    let apiKey = options.temporaryProviderKeys.get(provider.id);
    if (apiKey === undefined) {
      apiKey = await options.resolveApiKey(provider, signal);
      signal?.throwIfAborted();
      if (apiKey === undefined) {
        throw new Error(`未提供 ${provider.name} API Key。`);
      }
      options.temporaryProviderKeys.set(provider.id, apiKey);
    }

    const cacheKey = providerClientCacheKey(provider, config.timeoutMs);
    let clientsByCredential = clientCache.get(cacheKey);
    if (clientsByCredential === undefined) {
      clientsByCredential = new Map();
      clientCache.set(cacheKey, clientsByCredential);
    }
    let client = clientsByCredential.get(apiKey);
    if (client === undefined) {
      client = createClient({
        provider,
        apiKey,
        timeoutMs: config.timeoutMs,
      });
      clientsByCredential.set(apiKey, client);
    }
    return {client, model, provider};
  };
}

export async function streamCompactSummary(
  model: ModelClient,
  modelName: string,
  prompt: string,
  signal: AbortSignal,
  onProgress?: (streamTokens: number) => void,
): Promise<{text: string; streamTokens: number}> {
  let text = '';
  let streamTokens = 0;
  for await (const event of model.stream({
    model: modelName,
    messages: [{role: 'user', content: prompt}],
    toolChoice: 'none',
  }, signal)) {
    if (
      (event.type === 'reasoning_delta' || event.type === 'text_delta')
      && event.text.length > 0
    ) {
      streamTokens += 1;
      onProgress?.(streamTokens);
    }
    if (event.type === 'text_delta') text += event.text;
  }
  return {text, streamTokens};
}

export async function compactSessionHistory(options: {
  readEvents: () => Promise<readonly SessionEvent[]>;
  appendSummary: (
    event: Extract<SessionEvent, {type: 'summary'}>,
  ) => Promise<void>;
  model: ModelClient;
  modelName: string;
  signal: AbortSignal;
  onProgress?: (streamTokens: number) => void;
}): Promise<CompactResult> {
  const events = await options.readEvents().catch((): readonly SessionEvent[] => []);
  options.signal.throwIfAborted();
  let streamTokens = 0;
  const result = await compactHistory(events, async prompt => {
    const summary = await streamCompactSummary(
      options.model,
      options.modelName,
      prompt,
      options.signal,
      liveTokens => options.onProgress?.(streamTokens + liveTokens),
    );
    options.signal.throwIfAborted();
    streamTokens += summary.streamTokens;
    return summary.text;
  });
  options.signal.throwIfAborted();
  if (result.compacted) {
    options.signal.throwIfAborted();
    await options.appendSummary(result.summaryEvent);
    return {ok: true, message: '已压缩历史。', committed: true, streamTokens};
  }
  return {ok: false, message: result.reason, streamTokens};
}

async function main(): Promise<void> {
  if (args.has('--version') || args.has('-v')) { process.stdout.write(`${VERSION}\n`); return; }
  if (args.has('--help') || args.has('-h')) { showHelp(); return; }
  const paths = getAppPaths(
    process.env,
    resolveUserHome(process.env, homedir()),
  );
  let activeConfig = await loadOrCreateConfig(paths.configFile);
  const workspace = process.cwd();
  const currentWorkspaceId = workspaceId(workspace);
  const tempDir = join(tmpdir(), 'haochen'); await mkdir(tempDir, {recursive: true});
  const temporaryProviderKeys = new Map<string, string>();
  const interactiveTerminal =
    process.stdin.isTTY === true && process.stdout.isTTY === true;
  const credentialPrompts = new InteractiveCredentialPromptBroker(
    interactiveTerminal,
  );
  const resolveModelRuntime = createModelRuntimeResolver({
    getConfig: () => activeConfig,
    temporaryProviderKeys,
    resolveApiKey: (provider, signal) => resolveStartupApiKey({
      provider,
      env: process.env,
      readKeychain: readMacOsKeychain,
      prompt: () => signal === undefined
        ? Promise.resolve(undefined)
        : credentialPrompts.request(provider, signal),
    }),
  });
  const currentModel = () => activeConfig.models.find(
    candidate => candidate.id === activeConfig.activeModelId,
  );
  const store = new SessionStore(paths.sessionsDir); const sessionStore = createSerializedSessionStore(store); const audit = new AuditStore(paths.auditDir); const grants = new Set<string>();
  const confirmations = new InteractiveConfirmationBroker(
    interactiveTerminal,
  );
  const registry = new ToolRegistry({tools: toolDefinitions(), classify: classifyOperation, review: reviewOperation, confirm: request => confirmations.request(request), sessionGrants: grants, audit});
  const gateReporter = new GateReporter();
  let sessionId = createSessionId();
  await store.initialize(sessionId, currentWorkspaceId);
  const interruptionRouter = createTaskInterruptionRouter(
    (id, event) => sessionStore.append(id, event),
  );
  const saveModelConfig = createLatestModelConfigSaver({
    persist: async request => {
      request.signal.throwIfAborted();
      if (request.credential !== undefined && process.platform === 'darwin') {
        await saveMacOsKeychain(
          request.credential.apiKey,
          undefined,
          process.platform,
          request.credential.providerId,
        );
        request.signal.throwIfAborted();
      }
      await saveConfig(
        paths.configFile,
        request.config,
        undefined,
        request.signal,
      );
    },
    commit: request => {
      if (request.credential !== undefined) {
        temporaryProviderKeys.set(
          request.credential.providerId,
          request.credential.apiKey,
        );
      }
      activeConfig = request.config;
    },
  });
  const initialModel = currentModel();
  clearTerminalScreen(process.stdout);
  const instance = render(<App
    workspace={workspace} sessionId={sessionId} model={initialModel?.modelId ?? ''} contextTokens={initialModel?.contextWindow ?? 0} sessionGrants={grants}
    maxToolCalls={MAX_AGENT_TOOL_CALLS}
    modelConfig={activeConfig}
    modelConfigController={{
      discover: async request => {
        let apiKey = request.apiKey?.trim();
        if (!apiKey) {
          apiKey = temporaryProviderKeys.get(request.provider.id);
        }
        if (!apiKey) {
          apiKey = await resolveStartupApiKey({
            provider: request.provider,
            env: process.env,
            readKeychain: readMacOsKeychain,
            prompt: () => credentialPrompts.request(
              request.provider,
              request.signal,
            ),
          });
        }
        request.signal.throwIfAborted();
        if (!apiKey) {
          throw new Error(`未找到 ${request.provider.name} 的 API Key。`);
        }
        temporaryProviderKeys.set(request.provider.id, apiKey);
        return discoverModelsWithContext({
          provider: request.provider,
          apiKey,
          timeoutMs: activeConfig.timeoutMs,
          signal: request.signal,
        });
      },
      save: saveModelConfig,
      getCommittedConfig: () => activeConfig,
    }}
    workspaceId={currentWorkspaceId}
    credentialPrompt={credentialPrompts}
    runTask={async function* (task, signal) {
      const taskSessionId = sessionId;
      const taskInterruption = interruptionRouter.beginTask(taskSessionId);
      try {
        const runtime = await resolveModelRuntime(signal);
        yield* runAgentTask({task, model: runtime.client, modelName: runtime.model.modelId, registry, session: {id: taskSessionId, store: sessionStore}, workspace, tempDir, reviewClient: runtime.client, reviewModel: runtime.model.modelId, limits: {maxTurns: MAX_AGENT_TURNS, maxToolCalls: MAX_AGENT_TOOL_CALLS}, signal, maxContextTokens: runtime.model.contextWindow, appendInterrupted: taskInterruption.appendInterrupted, reportGate: event => gateReporter.report(event)});
      } finally {
        taskInterruption.finish();
      }
    }}
    executeTool={(name, input, signal) => registry.execute(name, input, {workspace, tempDir, taskSummary: '执行本地斜杠命令', reviewModel: currentModel()?.modelId ?? '', signal, reportGate: event => gateReporter.report(event)})}
    compact={async (signal, onProgress) => {
      const runtime = await resolveModelRuntime(signal);
      return compactSessionHistory({readEvents: () => sessionStore.read(sessionId), appendSummary: summaryEvent => sessionStore.append(sessionId, summaryEvent), model: runtime.client, modelName: runtime.model.modelId, signal, onProgress});
    }}
    saveSession={async reason => { await sessionStore.append(sessionId, {type: 'checkpoint', at: Date.now(), reason}); }} appendInterrupted={async reason => {
      await interruptionRouter.appendCurrent(sessionId, reason);
    }} createSession={async () => {
      const nextSessionId = createSessionId();
      await store.initialize(nextSessionId, currentWorkspaceId);
      sessionId = nextSessionId;
      return sessionId;
    }} listSessions={() => store.list()} resumeSession={async id => { await sessionStore.read(id); sessionId = id; return {id, message: `已恢复会话：${id}`}; }} onExit={async () => undefined} confirmation={confirmations} gateReporter={gateReporter}
  />, {exitOnCtrlC: false});
  await instance.waitUntilExit();
}

void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
