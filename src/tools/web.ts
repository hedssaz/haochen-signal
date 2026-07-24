import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {Readability} from '@mozilla/readability';
import {parseHTML} from 'linkedom';
import type {ToolContext, ToolResult} from './types.js';

const DUCKDUCKGO_HTML_URL = 'https://html.duckduckgo.com/html/';
const MAX_QUERY_CHARACTERS = 500;
const MAX_SEARCH_RESULTS = 10;
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ARTICLE_CHARACTERS = 40_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export type ResolveDns = (hostname: string) => Promise<readonly string[]>;

export interface WebToolDependencies {
  fetch?: typeof globalThis.fetch;
  resolveDns?: ResolveDns;
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
}

function failure<T>(code: string, message: string): ToolResult<T> {
  return {
    ok: false,
    summary: message,
    error: {code, message},
  };
}

function defaultResolveDns(hostname: string): Promise<readonly string[]> {
  return lookup(hostname, {all: true, verbatim: true})
    .then((addresses) => addresses.map((address) => address.address));
}

function ipv4Bytes(address: string): number[] {
  return address.split('.').map((segment) => Number(segment));
}

function isPublicIpv4(address: string): boolean {
  const [first, second, third] = ipv4Bytes(address);
  if (first === undefined || second === undefined || third === undefined) {
    return false;
  }

  if (first === 0
    || first === 10
    || first === 127
    || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0)
    || (first === 192 && second === 88 && third === 99)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)) {
    return false;
  }
  return true;
}

function expandIpv4Group(groups: string[]): string[] | undefined {
  const last = groups.at(-1);
  if (last === undefined || !last.includes('.')) return groups;
  if (isIP(last) !== 4) return undefined;
  const [first, second, third, fourth] = ipv4Bytes(last);
  if ([first, second, third, fourth].some((part) => part === undefined)) {
    return undefined;
  }
  return [
    ...groups.slice(0, -1),
    `${first!.toString(16).padStart(2, '0')}${second!.toString(16).padStart(2, '0')}`,
    `${third!.toString(16).padStart(2, '0')}${fourth!.toString(16).padStart(2, '0')}`,
  ];
}

function ipv6Bytes(address: string): Uint8Array | undefined {
  const normalized = address.toLowerCase();
  const parts = normalized.split('::');
  if (parts.length > 2) return undefined;

  const left = parts[0] === '' ? [] : parts[0]!.split(':');
  const right = parts.length === 1 || parts[1] === '' ? [] : parts[1]!.split(':');
  const initialGroups = expandIpv4Group([...left, ...right]);
  if (initialGroups === undefined) return undefined;

  const missing = 8 - initialGroups.length;
  if ((parts.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = parts.length === 2
    ? [...left, ...Array.from({length: missing}, () => '0'), ...right]
    : initialGroups;
  const expandedGroups = expandIpv4Group(groups);
  if (expandedGroups === undefined || expandedGroups.length !== 8) return undefined;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < expandedGroups.length; index += 1) {
    const group = expandedGroups[index]!;
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function isAllZero(bytes: Uint8Array, endExclusive: number): boolean {
  for (let index = 0; index < endExclusive; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function isPublicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return false;

  const isUnspecified = isAllZero(bytes, 16);
  const isLoopback = isAllZero(bytes, 15) && bytes[15] === 1;
  const isUniqueLocal = (bytes[0]! & 0xfe) === 0xfc;
  const isLinkLocal = bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80;
  const isMulticast = bytes[0] === 0xff;
  const isDocumentation = bytes[0] === 0x20
    && bytes[1] === 0x01
    && bytes[2] === 0x0d
    && bytes[3] === 0xb8;
  if (isUnspecified || isLoopback || isUniqueLocal || isLinkLocal
    || isMulticast || isDocumentation) {
    return false;
  }

  const isIpv4Mapped = isAllZero(bytes, 10)
    && bytes[10] === 0xff
    && bytes[11] === 0xff;
  if (isIpv4Mapped) {
    return isPublicIpv4(Array.from(bytes.slice(12)).join('.'));
  }

  const isIpv4Compatible = isAllZero(bytes, 12);
  if (isIpv4Compatible) return false;
  return true;
}

function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
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
export async function assertPublicHttpUrl(
  input: string,
  resolveDns: ResolveDns = defaultResolveDns,
): Promise<URL> {
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
    return url;
  }

  let addresses: readonly string[];
  try {
    addresses = await resolveDns(hostname);
  } catch {
    throw new WebToolError('WEB_DNS_FAILED', '无法解析网页目标地址');
  }
  if (!Array.isArray(addresses) || addresses.length === 0
    || addresses.some((address) => typeof address !== 'string'
      || !isPublicIpAddress(address))) {
    throw new WebToolError('WEB_URL_BLOCKED', '目标域名解析到非公网地址');
  }
  return url;
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

async function fetchWithValidatedRedirects(
  inputUrl: string,
  signal: AbortSignal,
  dependencies: WebToolDependencies,
): Promise<FetchedResponse> {
  const resolveDns = dependencies.resolveDns ?? defaultResolveDns;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  let url = await assertPublicHttpUrl(inputUrl, resolveDns);
  let redirects = 0;

  while (true) {
    assertNotAborted(signal);
    let response: Response;
    try {
      response = await fetcher(url, {
        redirect: 'manual',
        signal,
        headers: {accept: 'text/html,application/xhtml+xml'},
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new WebToolError('WEB_REQUEST_FAILED', '网页请求失败');
    }

    if (!isRedirect(response.status)) return {response, url};
    if (redirects >= MAX_REDIRECTS) {
      throw new WebToolError('WEB_REDIRECT_LIMIT', '网页重定向次数超过限制');
    }
    const location = response.headers.get('location');
    if (location === null || location === '') {
      throw new WebToolError('WEB_INVALID_RESPONSE', '网页重定向缺少目标地址');
    }
    let redirectedUrl: string;
    try {
      redirectedUrl = new URL(location, url).toString();
    } catch {
      throw new WebToolError('WEB_INVALID_RESPONSE', '网页重定向地址无效');
    }
    url = await assertPublicHttpUrl(redirectedUrl, resolveDns);
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
      const {done, value} = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytesRead += value.byteLength;
      if (bytesRead >= MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new WebToolError('WEB_RESPONSE_TOO_LARGE', '网页响应超过 2 MiB 限制');
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The reader can already be closed after a failed read.
    }
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
  if (query.length === 0 || query.length > MAX_QUERY_CHARACTERS) {
    return 'query 长度必须在 1 到 500 个字符之间';
  }
  if (input.limit !== undefined
    && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_SEARCH_RESULTS)) {
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
  const limit = input.limit ?? MAX_SEARCH_RESULTS;
  const searchUrl = new URL(DUCKDUCKGO_HTML_URL);
  searchUrl.searchParams.set('q', query);
  const request = createRequestControl(
    outerSignal,
    dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const {response} = await fetchWithValidatedRedirects(
      searchUrl.toString(),
      request.signal,
      dependencies,
    );
    if (!response.ok) {
      throw new WebToolError('WEB_HTTP_ERROR', `网页请求返回 HTTP ${response.status}`);
    }
    const html = await readResponseText(response, request.signal);
    const results = extractSearchResults(html, limit);
    return {
      ok: true,
      summary: `搜索到 ${results.length} 条公开网页结果`,
      data: {results},
    };
  } catch (error) {
    return failureFromError(error, outerSignal, request);
  } finally {
    request.dispose();
  }
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
  try {
    const {response, url} = await fetchWithValidatedRedirects(
      input.url,
      request.signal,
      dependencies,
    );
    if (!response.ok) {
      throw new WebToolError('WEB_HTTP_ERROR', `网页请求返回 HTTP ${response.status}`);
    }
    const html = await readResponseText(response, request.signal);
    const article = extractArticle(html);
    return {
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
    return failureFromError(error, outerSignal, request);
  } finally {
    request.dispose();
  }
}
