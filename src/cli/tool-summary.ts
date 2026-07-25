import {redactValue} from '../security/redact.js';

function patchSummary(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  const operations = (input as Record<string, unknown>).operations;
  if (!Array.isArray(operations)) return input;
  return {
    operations: operations.map(operation => {
      if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
        return operation;
      }
      const record = operation as Record<string, unknown>;
      return {
        ...(typeof record.type === 'string' ? {type: record.type} : {}),
        ...(typeof record.path === 'string' ? {path: record.path} : {}),
      };
    }),
  };
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return '[无法摘要]';
  }
}

function truncateCodePoints(value: string, limit: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= limit) return value;
  if (limit <= 0) return '';
  return `${codePoints.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

export function summarizeToolInput(
  tool: string,
  input: unknown,
  limit = 240,
): string {
  const redacted = redactValue(input);
  const summarized = tool === 'apply_patch' ? patchSummary(redacted) : redacted;
  return truncateCodePoints(safeJson(summarized), Math.max(0, Math.floor(limit)));
}
