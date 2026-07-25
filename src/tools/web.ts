import {Resolver} from 'node:dns/promises';
import {isIP, type LookupFunction} from 'node:net';
import {Readability} from '@mozilla/readability';
import ipaddr from 'ipaddr.js';
import {parseHTML} from 'linkedom';
import {Agent, type Dispatcher, fetch as undiciFetch} from 'undici';
import type {ToolContext, ToolResult} from './types.js';
import {
  WEB_SEARCH_QUERY_MAX_LENGTH,
  WEB_SEARCH_RESULT_LIMIT_DEFAULT,
  WEB_SEARCH_RESULT_LIMIT_MAX,
} from './web-contract.js';

const DUCKDUCKGO_HTML_URL = 'https://html.duckduckgo.com/html/';
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ARTICLE_CHARACTERS = 40_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export type ResolveDns = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly string[]>;

type WebFetchFunction = (
  input: string | URL,
  init?: RequestInit & {dispatcher?: Dispatcher},
) => Promise<Response>;

type CreatePinnedDispatcher = (
  hostname: string,
  addresses: readonly string[],
) => Dispatcher;

export interface WebToolDependencies {
  fetch?: WebFetchFunction;
  resolveDns?: ResolveDns;
  createDispatcher?: CreatePinnedDispatcher;
  timeoutMs?: number;
  now?: () => Date;
}

export interface WebSearchInput {
  query: string;
  limit?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutput {
  results: WebSearchResult[];
}

export interface WebFetchInput {
  url: string;
}

export interface WebFetchOutput {
  url: string;
  title: string;
  text: string;
  fetchedAt: string;
  externalUntrusted: true;
}

class WebToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WebToolError';
  }
}

interface RequestControl {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

interface FetchedResponse {
  response: Response;
  url: URL;
  dispatcher: Dispatcher;
}

interface ValidatedUrl {
  url: URL;
  hostname: string;
  addresses: readonly string[];
}

function failure<T>(code: string, message: string): ToolResult<T> {
  return {
    ok: false,
    summary: message,
    error: {code, message},
  };
}

async function defaultResolveDns(
  hostname: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  signal?.throwIfAborted();
  const resolver = new Resolver();
  const onAbort = (): void => resolver.cancel();
  signal?.addEventListener('abort', onAbort, {once: true});
  if (signal?.aborted) onAbort();

  try {
    const answers = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    signal?.throwIfAborted();
    const addresses = answers.flatMap((answer) => (
      answer.status === 'fulfilled' ? answer.value : []
    ));
    if (addresses.length === 0) {
      const failureAnswer = answers.find((answer) => answer.status === 'rejected');
      throw failureAnswer?.reason;
    }
    return addresses;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function isPublicIpAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6'
      && !parsed.match(ipaddr.IPv6.parse('2000::'), 3)) {
      return false;
    }
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}

function hostnameFromUrl(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === 'local'
    || hostname.endsWith('.local');
}

/**
 * Parses and validates a URL before the process sends a network request.
 * Every DNS answer must be a globally routable address so rebinding cannot
 * redirect an allowed hostname to local infrastructure.
 */
async function awaitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return promise;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason ?? new DOMException('网页请求已取消', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, {once: true});
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function validatePublicHttpUrl(
  input: string,
  resolveDns: ResolveDns,
  signal?: AbortSignal,
): Promise<ValidatedUrl> {
  signal?.throwIfAborted();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebToolError('WEB_URL_BLOCKED', '网页地址无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebToolError('WEB_URL_BLOCKED', '仅允许 HTTP 或 HTTPS 网页地址');
  }
  if (url.username !== '' || url.password !== '') {
    throw new WebToolError('WEB_URL_BLOCKED', '网页地址不能包含用户名或密码');
  }

  const hostname = hostnameFromUrl(url);
  if (hostname === '' || isLocalHostname(hostname)) {
    throw new WebToolError('WEB_URL_BLOCKED', '不允许访问本机或本地域名');
  }

  if (isIP(hostname) !== 0) {
    if (!isPublicIpAddress(hostname)) {
      throw new WebToolError('WEB_URL_BLOCKED', '目标地址不是公网地址');
    }
    return {url, hostname, addresses: [hostname]};
  }

  let addresses: readonly string[];
  try {
    addresses = await awaitWithSignal(resolveDns(hostname, signal), signal);
  } catch {
    signal?.throwIfAborted();
    throw new WebToolError('WEB_DNS_FAILED', '无法解析网页目标地址');
  }
  if (!Array.isArray(addresses) || addresses.length === 0
    || addresses.some((address) => typeof address !== 'string'
      || !isPublicIpAddress(address))) {
    throw new WebToolError('WEB_URL_BLOCKED', '目标域名解析到非公网地址');
  }
  return {url, hostname, addresses};
}

export async function assertPublicHttpUrl(
  input: string,
  resolveDns: ResolveDns = defaultResolveDns,
): Promise<URL> {
  return (await validatePublicHttpUrl(input, resolveDns)).url;
}

function createPinnedDispatcher(
  hostname: string,
  addresses: readonly string[],
): Dispatcher {
  const records = addresses.map((address) => ({
    address,
    family: isIP(address),
  }));
  const lookup: LookupFunction = (requestedHostname, options, callback) => {
    if (requestedHostname.toLowerCase().replace(/\.$/, '') !== hostname) {
      const error = Object.assign(new Error('拒绝解析未验证的主机名'), {
        code: 'ENOTFOUND',
      });
      callback(error, '', 0);
      return;
    }

    const candidates = options.family === 4 || options.family === 6
      ? records.filter((record) => record.family === options.family)
      : records;
    if (candidates.length === 0) {
      const error = Object.assign(new Error('没有已验证的目标地址族'), {
        code: 'ENOTFOUND',
      });
      callback(error, '', 0);
      return;
    }
    if (options.all === true) {
      callback(null, candidates);
      return;
    }
    const selected = candidates[0]!;
    callback(null, selected.address, selected.family);
  };

  return new Agent({
    connect: {
      lookup,
    },
  });
}

function createRequestControl(
  outerSignal: AbortSignal,
  timeoutMs: number,
): RequestControl {
  const controller = new AbortController();
  let timedOut = false;
  const onOuterAbort = (): void => controller.abort(outerSignal.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('网页请求超时', 'TimeoutError'));
  }, timeoutMs);
  outerSignal.addEventListener('abort', onOuterAbort, {once: true});
  if (outerSignal.aborted) onOuterAbort();

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      outerSignal.removeEventListener('abort', onOuterAbort);
    },
  };
}

function assertNotAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function isRedirect(status: number): boolean {
  return status === 301
    || status === 302
    || status === 303
    || status === 307
    || status === 308;
}

function destroyDispatcher(dispatcher: Dispatcher): void {
  try {
    void dispatcher.destroy().catch(() => undefined);
  } catch {
    // A custom dispatcher can throw synchronously while being destroyed.
  }
}

async function closeDispatcher(
  dispatcher: Dispatcher,
  signal: AbortSignal,
): Promise<void> {
  const closing = Promise.resolve()
    .then(async () => dispatcher.close())
    .catch(() => undefined);
  try {
    await awaitWithSignal(closing, signal);
  } catch {
    destroyDispatcher(dispatcher);
  }
}

async function disposeResponse(
  response: Response,
  dispatcher: Dispatcher,
  signal: AbortSignal,
): Promise<void> {
  const cancel = response.body === null
    ? Promise.resolve()
    : Promise.resolve()
      .then(async () => response.body?.cancel())
      .catch(() => undefined);
  const closing = Promise.resolve()
    .then(async () => dispatcher.close())
    .catch(() => undefined);
  const cleanup = Promise.all([cancel, closing]).then(() => undefined);
  try {
    await awaitWithSignal(cleanup, signal);
  } catch {
    destroyDispatcher(dispatcher);
  }
}

function redirectTarget(response: Response, url: URL, redirects: number): string {
  if (redirects >= MAX_REDIRECTS) {
    throw new WebToolError('WEB_REDIRECT_LIMIT', '网页重定向次数超过限制');
  }
  const location = response.headers.get('location');
  if (location === null || location === '') {
    throw new WebToolError('WEB_INVALID_RESPONSE', '网页重定向缺少目标地址');
  }
  try {
    return new URL(location, url).toString();
  } catch {
    throw new WebToolError('WEB_INVALID_RESPONSE', '网页重定向地址无效');
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  const cancelling = Promise.resolve()
    .then(async () => reader.cancel())
    .catch(() => undefined);
  try {
    await awaitWithSignal(cancelling, signal);
  } catch {
    // The total deadline wins over a stalled stream cancellation.
  }
}

async function fetchWithValidatedRedirects(
  inputUrl: string,
  signal: AbortSignal,
  dependencies: WebToolDependencies,
): Promise<FetchedResponse> {
  const resolveDns = dependencies.resolveDns ?? defaultResolveDns;
  const fetcher = dependencies.fetch ?? undiciFetch as unknown as WebFetchFunction;
  const dispatcherFactory = dependencies.createDispatcher ?? createPinnedDispatcher;
  let target = await validatePublicHttpUrl(inputUrl, resolveDns, signal);
  let redirects = 0;

  while (true) {
    assertNotAborted(signal);
    const dispatcher = dispatcherFactory(target.hostname, target.addresses);
    let response: Response;
    try {
      response = await fetcher(target.url, {
        redirect: 'manual',
        signal,
        headers: {accept: 'text/html,application/xhtml+xml'},
        dispatcher,
      });
    } catch (error) {
      await closeDispatcher(dispatcher, signal);
      if (signal.aborted) throw error;
      throw new WebToolError('WEB_REQUEST_FAILED', '网页请求失败');
    }

    if (!isRedirect(response.status)) {
      return {response, url: target.url, dispatcher};
    }

    let redirectedUrl: string;
    try {
      redirectedUrl = redirectTarget(response, target.url, redirects);
    } finally {
      await disposeResponse(response, dispatcher, signal);
    }
    target = await validatePublicHttpUrl(redirectedUrl, resolveDns, signal);
    redirects += 1;
  }
}

async function readResponseText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength)
    && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new WebToolError('WEB_RESPONSE_TOO_LARGE', '网页响应超过 2 MiB 限制');
  }
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      assertNotAborted(signal);
      const {done, value} = await awaitWithSignal(reader.read(), signal);
      if (done) break;
      if (value === undefined) continue;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        throw new WebToolError('WEB_RESPONSE_TOO_LARGE', '网页响应超过 2 MiB 限制');
      }
      chunks.push(value);
    }
  } catch (error) {
    await cancelReader(reader, signal);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function truncateArticle(text: string): {text: string; truncated: boolean} {
  const characters = Array.from(text);
  if (characters.length <= MAX_ARTICLE_CHARACTERS) {
    return {text, truncated: false};
  }
  return {
    text: characters.slice(0, MAX_ARTICLE_CHARACTERS).join(''),
    truncated: true,
  };
}

function extractArticle(html: string): {title: string; text: string; truncated: boolean} {
  const {document} = parseHTML(html);
  const article = new Readability(document, {charThreshold: 0}).parse();
  const text = normalizeText(article?.textContent ?? document.body?.textContent);
  if (text === '') {
    throw new WebToolError('WEB_INVALID_RESPONSE', '网页中没有可提取的正文');
  }
  const title = normalizeText(article?.title ?? document.title) || '未命名网页';
  const limited = truncateArticle(text);
  return {title, ...limited};
}

function extractSearchUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, DUCKDUCKGO_HTML_URL);
  } catch {
    return undefined;
  }
  if (url.hostname === 'duckduckgo.com' || url.hostname.endsWith('.duckduckgo.com')) {
    const destination = url.searchParams.get('uddg');
    if (destination !== null) {
      try {
        url = new URL(destination);
      } catch {
        return undefined;
      }
    }
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== '' || url.password !== '') {
    return undefined;
  }
  return url.toString();
}

function extractSearchResults(html: string, limit: number): WebSearchResult[] {
  const {document} = parseHTML(html);
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const anchor of document.querySelectorAll('a.result__a, a.result-link')) {
    const href = anchor.getAttribute('href');
    const url = href === null ? undefined : extractSearchUrl(href);
    const title = normalizeText(anchor.textContent);
    if (url === undefined || title === '' || seen.has(url)) continue;
    const resultElement = anchor.closest('.result');
    const snippet = normalizeText(
      resultElement?.querySelector('.result__snippet, .result-snippet')?.textContent,
    );
    results.push({title, url, snippet});
    seen.add(url);
    if (results.length === limit) break;
  }
  return results;
}

function failureFromError<T>(
  error: unknown,
  outerSignal: AbortSignal,
  request: RequestControl,
): ToolResult<T> {
  if (request.timedOut()) return failure('WEB_TIMEOUT', '网页请求超时');
  if (outerSignal.aborted || error instanceof DOMException && error.name === 'AbortError') {
    return failure('ABORTED', '网页请求已取消');
  }
  if (error instanceof WebToolError) return failure(error.code, error.message);
  return failure('WEB_REQUEST_FAILED', '网页请求失败');
}

function validSearchInput(input: WebSearchInput): string | undefined {
  if (input === null || typeof input !== 'object' || typeof input.query !== 'string') {
    return 'query 必须是字符串';
  }
  const query = input.query.trim();
  if (query.length === 0 || query.length > WEB_SEARCH_QUERY_MAX_LENGTH) {
    return 'query 长度必须在 1 到 500 个字符之间';
  }
  if (input.limit !== undefined
    && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > WEB_SEARCH_RESULT_LIMIT_MAX)) {
    return 'limit 必须是 1 到 10 的整数';
  }
  return undefined;
}

function validFetchInput(input: WebFetchInput): string | undefined {
  if (input === null || typeof input !== 'object' || typeof input.url !== 'string'
    || input.url.trim() === '') {
    return 'url 必须是非空字符串';
  }
  return undefined;
}

export async function webSearch(
  input: WebSearchInput,
  _context: ToolContext,
  outerSignal: AbortSignal,
  dependencies: WebToolDependencies = {},
): Promise<ToolResult<WebSearchOutput>> {
  const inputError = validSearchInput(input);
  if (inputError !== undefined) return failure('INVALID_INPUT', inputError);

  const query = input.query.trim();
  const limit = input.limit ?? WEB_SEARCH_RESULT_LIMIT_DEFAULT;
  const searchUrl = new URL(DUCKDUCKGO_HTML_URL);
  searchUrl.searchParams.set('q', query);
  const request = createRequestControl(
    outerSignal,
    dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let fetched: FetchedResponse | undefined;
  let result: ToolResult<WebSearchOutput>;
  try {
    fetched = await fetchWithValidatedRedirects(
      searchUrl.toString(),
      request.signal,
      dependencies,
    );
    const {response} = fetched;
    if (!response.ok) {
      throw new WebToolError('WEB_HTTP_ERROR', `网页请求返回 HTTP ${response.status}`);
    }
    const html = await readResponseText(response, request.signal);
    const results = extractSearchResults(html, limit);
    result = {
      ok: true,
      summary: `搜索到 ${results.length} 条公开网页结果`,
      data: {results},
    };
  } catch (error) {
    result = failureFromError(error, outerSignal, request);
  } finally {
    if (fetched !== undefined) {
      await disposeResponse(fetched.response, fetched.dispatcher, request.signal);
    }
    request.dispose();
  }
  if (request.signal.aborted) {
    return failureFromError(request.signal.reason, outerSignal, request);
  }
  return result;
}

export async function webFetch(
  input: WebFetchInput,
  _context: ToolContext,
  outerSignal: AbortSignal,
  dependencies: WebToolDependencies = {},
): Promise<ToolResult<WebFetchOutput>> {
  const inputError = validFetchInput(input);
  if (inputError !== undefined) return failure('INVALID_INPUT', inputError);

  const request = createRequestControl(
    outerSignal,
    dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let fetched: FetchedResponse | undefined;
  let result: ToolResult<WebFetchOutput>;
  try {
    fetched = await fetchWithValidatedRedirects(
      input.url,
      request.signal,
      dependencies,
    );
    const {response, url} = fetched;
    if (!response.ok) {
      throw new WebToolError('WEB_HTTP_ERROR', `网页请求返回 HTTP ${response.status}`);
    }
    const html = await readResponseText(response, request.signal);
    const article = extractArticle(html);
    result = {
      ok: true,
      summary: `已提取网页正文：${article.title}`,
      data: {
        url: url.toString(),
        title: article.title,
        text: article.text,
        fetchedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
        externalUntrusted: true,
      },
      truncated: article.truncated,
    };
  } catch (error) {
    result = failureFromError(error, outerSignal, request);
  } finally {
    if (fetched !== undefined) {
      await disposeResponse(fetched.response, fetched.dispatcher, request.signal);
    }
    request.dispose();
  }
  if (request.signal.aborted) {
    return failureFromError(request.signal.reason, outerSignal, request);
  }
  return result;
}
