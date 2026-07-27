import {isIP} from 'node:net';
import type {BoundaryContext} from '../types.js';
import {
  cleanToken,
  dequoteShellText,
  inputError,
  normalizePath,
  normalizedExecutable,
  unwrapCommand,
} from './common.js';

function curlResolveAddresses(specification: string): string[] {
  let value = specification;
  if (value.startsWith('+')) value = value.slice(1);
  if (value.startsWith('-')) return [];

  let hostEnd: number;
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    if (closingBracket === -1 || value[closingBracket + 1] !== ':') {
      inputError('curl --resolve 主机覆盖格式无效');
    }
    hostEnd = closingBracket + 1;
  } else {
    hostEnd = value.indexOf(':');
    if (hostEnd <= 0) inputError('curl --resolve 主机覆盖格式无效');
  }
  const portEnd = value.indexOf(':', hostEnd + 1);
  if (portEnd === -1 || portEnd === value.length - 1) {
    inputError('curl --resolve 主机覆盖格式无效');
  }
  const addresses = value.slice(portEnd + 1).split(',');
  if (addresses.some((address) => address.length === 0)) {
    inputError('curl --resolve 主机覆盖格式无效');
  }
  return addresses.map((address) => {
    const normalized = normalizeIpAddress(address);
    if (normalized === undefined) {
      inputError('curl --resolve 地址必须是 IP 字面量');
    }
    return normalized;
  });
}

function normalizeIpAddress(value: string): string | undefined {
  const literal = value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value;
  const directVersion = isIP(literal);
  if (directVersion !== 0) return literal.toLowerCase();
  if (literal.includes(':')) return undefined;

  try {
    const parsed = new URL(`http://${literal}`);
    if (parsed.username !== ''
      || parsed.password !== ''
      || parsed.port !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== '') {
      return undefined;
    }
    const hostname = parsed.hostname.startsWith('[')
      && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    return isIP(hostname) === 0 ? undefined : hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function curlConnectToAddress(specification: string): string | undefined {
  let position = 0;
  const readHost = (): string | undefined => {
    if (specification[position] === '[') {
      const closing = specification.indexOf(']', position + 1);
      if (closing === -1 || specification[closing + 1] !== ':') {
        inputError('curl --connect-to 主机覆盖格式无效');
      }
      const host = specification.slice(position + 1, closing);
      position = closing + 2;
      return host;
    }
    const separator = specification.indexOf(':', position);
    if (separator === -1) inputError('curl --connect-to 主机覆盖格式无效');
    const host = specification.slice(position, separator);
    position = separator + 1;
    return host;
  };
  const readPort = (): void => {
    const separator = specification.indexOf(':', position);
    if (separator === -1) inputError('curl --connect-to 主机覆盖格式无效');
    if (separator === position) inputError('curl --connect-to 主机覆盖格式无效');
    position = separator + 1;
  };

  readHost();
  readPort();
  const destination = readHost();
  if (destination === undefined || position >= specification.length) {
    inputError('curl --connect-to 主机覆盖格式无效');
  }
  if (specification.slice(position).length === 0) {
    inputError('curl --connect-to 主机覆盖格式无效');
  }
  return destination === '' ? undefined : destination;
}

function curlOptionSpecifications(
  args: string[],
  option: '--resolve' | '--connect-to',
): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (argument === option) {
      const value = args[index + 1];
      if (value === undefined) inputError(`curl ${option} 缺少主机覆盖值`);
      values.push(value);
      index += 1;
    } else if (argument.startsWith(`${option}=`)) {
      values.push(argument.slice(option.length + 1));
    }
  }
  return values;
}

function shellCurlArguments(command: string, args: string[]): string[][] {
  const sets: string[][] = [];
  for (const value of [command, ...args]) {
    const text = dequoteShellText(value);
    if (/(?:^|[\s;&|])curl(?:\s|$)/u.test(text)) {
      sets.push(text.split(/\s+/u));
    }
  }
  return sets;
}

function envSplitCurlArguments(command: string, args: string[]): string[][] {
  if (!unwrapCommand(command, args).commands.includes('env')) return [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    let payload: string | undefined;
    let remaining: string[];
    if (argument === '-S' || argument === '--split-string') {
      payload = args[index + 1];
      remaining = args.slice(index + 2);
    } else if (argument.startsWith('--split-string=')) {
      payload = argument.slice('--split-string='.length);
      remaining = args.slice(index + 1);
    } else if (argument.startsWith('-S') && argument.length > 2) {
      payload = argument.slice(2);
      remaining = args.slice(index + 1);
    } else {
      continue;
    }
    if (payload === undefined) return [];

    const tokens = [
      ...dequoteShellText(payload).trim().split(/\s+/u),
      ...remaining,
    ];
    if (normalizedExecutable(tokens[0] ?? '') === 'curl') {
      return [tokens.slice(1)];
    }
    return [];
  }
  return [];
}

function curlArgumentSets(
  command: string,
  args: string[],
  shellSemantics: boolean,
): string[][] {
  const effective = unwrapCommand(command, args);
  const sets = effective.command === 'curl' ? [effective.args] : [];
  if (shellSemantics) sets.push(...shellCurlArguments(command, args));
  sets.push(...envSplitCurlArguments(command, args));
  return sets;
}

function curlFilePathCandidates(
  command: string,
  args: string[],
  shellSemantics: boolean,
): string[] {
  const candidates: string[] = [];
  for (const curlArgs of curlArgumentSets(command, args, shellSemantics)) {
    for (let index = 0; index < curlArgs.length; index += 1) {
      const argument = curlArgs[index] ?? '';
      const uploadMatch = /^--upload-file=(.+)$/u.exec(argument)
        ?? /^-[A-Za-z]*T(.+)$/u.exec(argument);
      if (uploadMatch?.[1] !== undefined && uploadMatch[1] !== '-') {
        candidates.push(uploadMatch[1]);
      } else if (argument === '--upload-file') {
        const path = curlArgs[index + 1];
        if (path !== undefined && path !== '-') candidates.push(path);
        index += 1;
      }

      const filePattern = /@((?:[^@\s'"`;&|<>])+)/gu;
      let match = filePattern.exec(argument);
      while (match !== null) {
        if (match[1] !== undefined && match[1] !== '-') {
          candidates.push(match[1]);
        }
        match = filePattern.exec(argument);
      }
    }
  }
  return [...new Set(candidates)];
}

export async function normalizeCurlFileTargets(
  command: string,
  args: string[],
  context: BoundaryContext,
  shellSemantics: boolean,
): Promise<string[]> {
  const targets: string[] = [];
  for (const candidate of curlFilePathCandidates(
    command,
    args,
    shellSemantics,
  )) {
    const path = await normalizePath(
      context,
      candidate,
      'new',
      'curl 文件参数路径',
    );
    targets.push(`path:${path}`);
  }
  return targets;
}

export function normalizeCommandNetworkOverrides(
  command: string,
  args: string[],
  shellSemantics: boolean,
): string[] {
  const scope: string[] = [];
  for (const curlArgs of curlArgumentSets(command, args, shellSemantics)) {
    for (const specification of curlOptionSpecifications(curlArgs, '--resolve')) {
      for (const address of curlResolveAddresses(specification)) {
        const version = isIP(address);
        if (version === 0) inputError('curl --resolve 地址必须是 IP 字面量');
        if ((version === 4 && !ipv4IsPublic(address))
          || (version === 6 && !ipv6IsPublic(address))) {
          inputError('curl --resolve 目标位于本机、内网或保留地址');
        }
        scope.push(`network:${address.toLowerCase()}`);
      }
    }
    for (const specification of curlOptionSpecifications(curlArgs, '--connect-to')) {
      const address = curlConnectToAddress(specification);
      if (address === undefined) continue;
      const normalizedAddress = normalizeIpAddress(address);
      const version = normalizedAddress === undefined ? 0 : isIP(normalizedAddress);
      if (version === 0 && nonPublicHostname(address)) {
        inputError('curl --connect-to 目标位于本机、内网或保留地址');
      }
      if ((version === 4 && !ipv4IsPublic(normalizedAddress ?? address))
        || (version === 6 && !ipv6IsPublic(normalizedAddress ?? address))) {
        inputError('curl --connect-to 目标位于本机、内网或保留地址');
      }
      if (normalizedAddress !== undefined) {
        scope.push(`network:${normalizedAddress}`);
      }
    }
  }
  return [...new Set(scope)];
}

function ipv4IsPublic(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4
    || octets.some((octet) => !Number.isInteger(octet)
      || octet < 0
      || octet > 255)) {
    return false;
  }
  const [first, second] = octets;
  if (first === undefined || second === undefined) return false;
  return !(first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && [
      0,
      2,
      168,
    ].includes(second))
    || (first === 198 && [18, 19, 51].includes(second))
    || (first === 203 && second === 0)
    || first >= 224);
}

function ipv6Words(host: string): number[] | undefined {
  const unwrapped = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host;
  if (unwrapped.includes('%') || unwrapped.split('::').length > 2) {
    return undefined;
  }
  const halves = unwrapped.split('::');
  const left = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const right = halves.length === 1 || halves[1] === ''
    ? []
    : (halves[1] ?? '').split(':');
  if ([...left, ...right].some((part) => !/^[a-f0-9]{1,4}$/iu.test(part))) {
    return undefined;
  }
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0)
    || (halves.length === 2 && missing < 1)) {
    return undefined;
  }
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({length: missing}, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
}

function ipv6IsPublic(host: string): boolean {
  const words = ipv6Words(host);
  if (words === undefined || words.length !== 8) return false;
  const first = words[0] ?? 0;
  const allZeroPrefix = words.slice(0, 6).every((word) => word === 0);
  if (words.every((word) => word === 0)
    || (words.slice(0, 7).every((word) => word === 0)
      && words[7] === 1)
    || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xffc0) === 0xfec0
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && words[1] === 0x0db8)) {
    return false;
  }
  if (allZeroPrefix || (words.slice(0, 5).every((word) => word === 0)
    && words[5] === 0xffff)) {
    const ipv4 = `${(words[6] ?? 0) >> 8}.${(words[6] ?? 0) & 0xff}.`
      + `${(words[7] ?? 0) >> 8}.${(words[7] ?? 0) & 0xff}`;
    return ipv4IsPublic(ipv4);
  }
  return true;
}

function nonPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  return host === ''
    || host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.lan');
}

export function normalizePublicUrl(value: unknown): string {
  const raw = cleanToken(value, 'url');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    inputError('URL 格式无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    inputError('URL 只允许 HTTP 或 HTTPS');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    inputError('URL 不得包含凭据');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  if (/[{}[\]]/u.test(host) || nonPublicHostname(host)) {
    inputError('URL 目标不是公开主机');
  }
  const ipVersion = isIP(host.startsWith('[') ? host.slice(1, -1) : host);
  if ((ipVersion === 4 && !ipv4IsPublic(host))
    || (ipVersion === 6 && !ipv6IsPublic(host))
    || host.includes('%')) {
    inputError('URL 目标位于本机、内网或保留地址');
  }
  parsed.hostname = host;
  return parsed.href;
}
