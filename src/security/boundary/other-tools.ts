import {
  WEB_SEARCH_QUERY_MAX_LENGTH,
  WEB_SEARCH_RESULT_LIMIT_DEFAULT,
  WEB_SEARCH_RESULT_LIMIT_MAX,
} from '../../tools/web-contract.js';
import type {BoundaryContext} from '../types.js';
import {
  inputError,
  onlyKeys,
  optionalBoolean,
  optionalInteger,
  record,
  requiredString,
} from './common.js';
import {normalizePublicUrl} from './network-policy.js';
import type {NormalizedOperation} from './types.js';

const DEFAULT_GIT_LOG_LIMIT = 20;

export function normalizeGitTool(
  tool: string,
  value: unknown,
  _context: BoundaryContext,
): NormalizedOperation {
  const input = record(value, `${tool} input`);
  if (tool === 'git_status') {
    onlyKeys(input, [], `${tool} input`);
    return {
      input: {},
      scope: ['git:status'],
      confirmReasons: [],
      reviewReasons: [],
      allowReason: '操作只读取 Git 状态',
    };
  }
  if (tool === 'git_diff') {
    onlyKeys(input, ['staged'], `${tool} input`);
    const staged = optionalBoolean(input.staged, 'staged', false);
    return {
      input: {staged},
      scope: [staged ? 'git:diff:staged' : 'git:diff:working-tree'],
      confirmReasons: [],
      reviewReasons: [],
      allowReason: '操作只读取 Git 差异',
    };
  }
  onlyKeys(input, ['limit'], `${tool} input`);
  const limit = optionalInteger(
    input.limit,
    'limit',
    DEFAULT_GIT_LOG_LIMIT,
    1,
    100,
  );
  return {
    input: {limit},
    scope: [`git:log:${limit}`],
    confirmReasons: [],
    reviewReasons: [],
    allowReason: '操作只读取 Git 日志',
  };
}

export function normalizeWebTool(
  tool: string,
  value: unknown,
  _context: BoundaryContext,
): NormalizedOperation {
  const input = record(value, `${tool} input`);
  if (tool === 'web_search') {
    onlyKeys(input, ['query', 'limit'], `${tool} input`);
    const query = requiredString(input.query, 'query').trim();
    if (query.length === 0) inputError('query 不能为空');
    if (query.length > WEB_SEARCH_QUERY_MAX_LENGTH) {
      inputError(`query 长度不能超过 ${WEB_SEARCH_QUERY_MAX_LENGTH}`);
    }
    const limit = optionalInteger(
      input.limit,
      'limit',
      WEB_SEARCH_RESULT_LIMIT_DEFAULT,
      1,
      WEB_SEARCH_RESULT_LIMIT_MAX,
    );
    return {
      input: {query, limit},
      scope: [`search:${query}:${limit}`],
      confirmReasons: [],
      reviewReasons: [],
      allowReason: '操作只搜索公开技术资料',
    };
  }
  onlyKeys(input, ['url'], `${tool} input`);
  const url = normalizePublicUrl(input.url);
  return {
    input: {url},
    scope: [`url:${url}`],
    confirmReasons: [],
    reviewReasons: [],
    allowReason: '操作只读取公开 HTTP/HTTPS 内容',
  };
}
