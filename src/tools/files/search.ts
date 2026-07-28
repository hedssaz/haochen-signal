import {resolveWorkspacePath} from '../../security/path-boundary.js';
import type {ToolContext, ToolResult} from '../types.js';
import {
  FileToolError,
  assertNotAborted,
  failure,
  success,
} from './common.js';
import {isBinary} from './file-access.js';
import {collectRegularFiles, readSearchFile} from './read.js';
import {consumeTextLines} from './text-lines.js';
import type {
  SearchMatch,
  SearchTextInput,
  SearchTextOutput,
} from './types.js';


const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_PREVIEW_CHARACTERS = 240;

function splitTextLines(text: string): string[] {
  const lines: string[] = [];
  consumeTextLines({pending: ''}, text, true, (line) => lines.push(line));
  return lines;
}

function searchPreview(
  line: string,
  matchIndex: number,
  queryLength: number,
): string {
  if (line.length <= MAX_SEARCH_PREVIEW_CHARACTERS) return line;

  const contentBudget = MAX_SEARCH_PREVIEW_CHARACTERS - 2;
  const matchBudget = Math.min(queryLength, contentBudget);
  const contextBefore = Math.floor((contentBudget - matchBudget) / 2);
  let start = Math.max(0, matchIndex - contextBefore);
  let end = Math.min(line.length, start + contentBudget);
  if (end === line.length) start = Math.max(0, end - contentBudget);
  end = Math.min(line.length, start + contentBudget);

  const prefix = start > 0 ? '…' : '';
  const suffix = end < line.length ? '…' : '';
  return `${prefix}${line.slice(start, end)}${suffix}`;
}


export async function searchText(
  input: SearchTextInput,
  context: ToolContext,
  signal: AbortSignal,
): Promise<ToolResult<SearchTextOutput>> {
  try {
    assertNotAborted(signal);
    if (typeof input.query !== 'string' || input.query.length === 0) {
      throw new FileToolError('INVALID_INPUT', '搜索文本不能为空');
    }
    if (input.maxMatches !== undefined
      && (!Number.isInteger(input.maxMatches) || input.maxMatches < 1)) {
      throw new FileToolError('INVALID_INPUT', '搜索结果上限必须是正整数');
    }

    const limit = Math.min(input.maxMatches ?? MAX_SEARCH_MATCHES, MAX_SEARCH_MATCHES);
    const {files} = await collectRegularFiles(
      input.path ?? '.',
      context,
      signal,
    );
    const matches: SearchMatch[] = [];
    let truncated = false;

    search:
    for (const path of files) {
      assertNotAborted(signal);
      const resolved = await resolveWorkspacePath(
        context.workspace,
        path,
        'existing',
      );
      const contents = await readSearchFile(resolved, context);
      if (contents === undefined || isBinary(contents)) continue;

      const lines = splitTextLines(contents.toString('utf8'));
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? '';
        let columnIndex = line.indexOf(input.query);
        while (columnIndex !== -1) {
          if (matches.length === limit) {
            truncated = true;
            break search;
          }
          matches.push({
            path,
            line: lineIndex + 1,
            column: columnIndex + 1,
            preview: searchPreview(
              line,
              columnIndex,
              input.query.length,
            ),
          });
          columnIndex = line.indexOf(input.query, columnIndex + 1);
        }
      }
    }

    return success(
      `找到 ${matches.length} 个匹配`,
      {matches},
      truncated,
    );
  } catch (error) {
    return failure(error, signal);
  }
}
