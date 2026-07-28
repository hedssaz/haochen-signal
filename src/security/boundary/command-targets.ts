import {isAbsolute, win32} from 'node:path';
import type {BoundaryContext} from '../types.js';
import {
  inputError,
  normalizePath,
} from './common.js';
import {normalizePublicUrl} from './network-policy.js';

function candidatePath(argument: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(argument)) return undefined;
  if (argument.startsWith('file:')) return argument.slice('file:'.length);
  const equals = argument.indexOf('=');
  const value = equals === -1 ? argument : argument.slice(equals + 1);
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return undefined;
  if (value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('.\\')
    || value.startsWith('..\\')
    || value.startsWith('~/')
    || value.startsWith('~\\')
    || /^[A-Za-z]:[\\/]/u.test(value)
    || value.startsWith('\\\\')) {
    return value;
  }
  if (!/\s/u.test(value)
    && value.includes('/')
    && !value.startsWith('@')) {
    return value;
  }
  return undefined;
}

function embeddedPathCandidates(argument: string): string[] {
  const candidates: string[] = [];
  const pattern = /(?:^|[\s'"`;&|<>])((?:\.\.?[\\/]|~[\\/]|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^\s'"`;&|<>]*)/gu;
  let match = pattern.exec(argument);
  while (match !== null) {
    const candidate = match[1];
    if (candidate !== undefined) candidates.push(candidate);
    match = pattern.exec(argument);
  }
  return candidates;
}

function commandUrlCandidates(argument: string): string[] {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(argument)) return [argument];
  return argument.match(
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"`;&|<>]+/gu,
  ) ?? [];
}

export async function normalizeCommandTargets(
  targetTexts: string[][],
  compactPathCandidates: string[],
  context: BoundaryContext,
): Promise<string[]> {
  const scope: string[] = [];
  const seen = new Set<string>();
  for (const texts of targetTexts) {
    for (const text of texts) {
      for (const rawUrl of commandUrlCandidates(text)) {
        const url = normalizePublicUrl(rawUrl);
        const target = `url:${url}`;
        if (!seen.has(target)) {
          seen.add(target);
          scope.push(target);
        }
      }
    }
    const candidates = texts.flatMap((text) => {
      const direct = candidatePath(text);
      return direct === undefined ? embeddedPathCandidates(text) : [direct];
    });
    for (const candidate of candidates) {
      if (candidate.startsWith('~/')
        || candidate.startsWith('~\\')
        || (win32.isAbsolute(candidate) && !isAbsolute(candidate))) {
        inputError('命令参数包含工作区外路径');
      }
      const path = await normalizePath(
        context,
        candidate,
        'new',
        '命令参数路径',
      );
      const target = `path:${path}`;
      if (!seen.has(target)) {
        seen.add(target);
        scope.push(target);
      }
    }
  }
  for (const candidate of compactPathCandidates) {
    const path = await normalizePath(
      context,
      candidate,
      'new',
      '命令紧凑参数路径',
    );
    const target = `path:${path}`;
    if (!seen.has(target)) {
      seen.add(target);
      scope.push(target);
    }
  }
  return scope;
}
