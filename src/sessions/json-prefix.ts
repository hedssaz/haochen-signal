type JsonPrefixStatus = 'complete' | 'truncated' | 'invalid';

type ObjectState =
  | 'first-key-or-end'
  | 'key'
  | 'colon'
  | 'value'
  | 'comma-or-end';

type ArrayState = 'first-value-or-end' | 'value' | 'comma-or-end';

type Frame =
  | {type: 'object'; state: ObjectState}
  | {type: 'array'; state: ArrayState};

type Token =
  | {
      type: 'string';
      role: 'key' | 'value';
      escaped: boolean;
      unicodeDigits: number;
    }
  | {type: 'literal'; expected: string; offset: number}
  | {type: 'number'; value: string};

function isJsonWhitespace(character: string): boolean {
  return character === '\u0020'
    || character === '\t'
    || character === '\r'
    || character === '\n';
}

function numberStatus(value: string): 'complete' | 'prefix' | 'invalid' {
  let offset = 0;
  if (value[offset] === '-') {
    offset += 1;
    if (offset === value.length) return 'prefix';
  }

  if (value[offset] === '0') {
    offset += 1;
  } else if (/[1-9]/.test(value[offset] ?? '')) {
    offset += 1;
    while (/[0-9]/.test(value[offset] ?? '')) offset += 1;
  } else {
    return 'invalid';
  }

  if (value[offset] === '.') {
    offset += 1;
    if (offset === value.length) return 'prefix';
    if (!/[0-9]/.test(value[offset] ?? '')) return 'invalid';
    while (/[0-9]/.test(value[offset] ?? '')) offset += 1;
  }

  if (value[offset] === 'e' || value[offset] === 'E') {
    offset += 1;
    if (offset === value.length) return 'prefix';
    if (value[offset] === '+' || value[offset] === '-') {
      offset += 1;
      if (offset === value.length) return 'prefix';
    }
    if (!/[0-9]/.test(value[offset] ?? '')) return 'invalid';
    while (/[0-9]/.test(value[offset] ?? '')) offset += 1;
  }

  return offset === value.length ? 'complete' : 'invalid';
}

export function jsonPrefixStatus(source: string): JsonPrefixStatus {
  const frames: Frame[] = [];
  let token: Token | undefined;
  let rootStarted = false;
  let rootComplete = false;
  let invalid = false;

  const completeValue = (): void => {
    const frame = frames.at(-1);
    if (!frame) {
      rootComplete = true;
    } else if (frame.type === 'object' && frame.state === 'value') {
      frame.state = 'comma-or-end';
    } else if (
      frame.type === 'array'
      && (frame.state === 'first-value-or-end' || frame.state === 'value')
    ) {
      frame.state = 'comma-or-end';
    } else {
      invalid = true;
    }
  };

  const closeFrame = (type: Frame['type']): void => {
    if (frames.at(-1)?.type !== type) {
      invalid = true;
      return;
    }
    frames.pop();
    completeValue();
  };

  const startValue = (character: string): boolean => {
    if (character === '{') {
      frames.push({type: 'object', state: 'first-key-or-end'});
    } else if (character === '[') {
      frames.push({type: 'array', state: 'first-value-or-end'});
    } else if (character === '"') {
      token = {type: 'string', role: 'value', escaped: false, unicodeDigits: 0};
    } else if (character === 't') {
      token = {type: 'literal', expected: 'true', offset: 1};
    } else if (character === 'f') {
      token = {type: 'literal', expected: 'false', offset: 1};
    } else if (character === 'n') {
      token = {type: 'literal', expected: 'null', offset: 1};
    } else if (character === '-' || /[0-9]/.test(character)) {
      token = {type: 'number', value: character};
    } else {
      return false;
    }
    return true;
  };

  let offset = 0;
  while (offset < source.length && !invalid) {
    const character = source[offset] ?? '';

    if (token?.type === 'string') {
      if (token.unicodeDigits > 0) {
        if (!/[0-9a-f]/i.test(character)) {
          invalid = true;
        } else {
          token.unicodeDigits -= 1;
        }
      } else if (token.escaped) {
        if (character === 'u') {
          token.unicodeDigits = 4;
        } else if (!/["\\/bfnrt]/.test(character)) {
          invalid = true;
        }
        token.escaped = false;
      } else if (character === '\\') {
        token.escaped = true;
      } else if (character === '"') {
        const role = token.role;
        token = undefined;
        if (role === 'key') {
          const frame = frames.at(-1);
          if (frame?.type !== 'object'
            || (frame.state !== 'first-key-or-end' && frame.state !== 'key')) {
            invalid = true;
          } else {
            frame.state = 'colon';
          }
        } else {
          completeValue();
        }
      } else if (character.charCodeAt(0) < 0x20) {
        invalid = true;
      }
      offset += 1;
      continue;
    }

    if (token?.type === 'literal') {
      if (character !== token.expected[token.offset]) {
        invalid = true;
      } else {
        token.offset += 1;
        if (token.offset === token.expected.length) {
          token = undefined;
          completeValue();
        }
      }
      offset += 1;
      continue;
    }

    if (token?.type === 'number') {
      if (/[0-9eE+.-]/.test(character)) {
        token.value += character;
        offset += 1;
        continue;
      }
      if (numberStatus(token.value) !== 'complete') {
        invalid = true;
        continue;
      }
      token = undefined;
      completeValue();
      continue;
    }

    if (isJsonWhitespace(character)) {
      offset += 1;
      continue;
    }
    if (rootComplete) {
      invalid = true;
      continue;
    }
    if (!rootStarted) {
      if (character !== '{') {
        invalid = true;
      } else {
        rootStarted = true;
        frames.push({type: 'object', state: 'first-key-or-end'});
      }
      offset += 1;
      continue;
    }

    const frame = frames.at(-1);
    if (!frame) {
      invalid = true;
      continue;
    }

    if (frame.type === 'object') {
      if (frame.state === 'first-key-or-end' && character === '}') {
        closeFrame('object');
      } else if (
        (frame.state === 'first-key-or-end' || frame.state === 'key')
        && character === '"'
      ) {
        token = {type: 'string', role: 'key', escaped: false, unicodeDigits: 0};
      } else if (frame.state === 'colon' && character === ':') {
        frame.state = 'value';
      } else if (frame.state === 'value') {
        if (!startValue(character)) invalid = true;
      } else if (frame.state === 'comma-or-end' && character === ',') {
        frame.state = 'key';
      } else if (frame.state === 'comma-or-end' && character === '}') {
        closeFrame('object');
      } else {
        invalid = true;
      }
    } else if (frame.state === 'first-value-or-end' && character === ']') {
      closeFrame('array');
    } else if (
      frame.state === 'first-value-or-end'
      || frame.state === 'value'
    ) {
      if (!startValue(character)) invalid = true;
    } else if (frame.state === 'comma-or-end' && character === ',') {
      frame.state = 'value';
    } else if (frame.state === 'comma-or-end' && character === ']') {
      closeFrame('array');
    } else {
      invalid = true;
    }

    offset += 1;
  }

  if (invalid) return 'invalid';
  if (token?.type === 'number') {
    const status = numberStatus(token.value);
    if (status === 'invalid') return 'invalid';
    if (status === 'prefix') return 'truncated';
    token = undefined;
    completeValue();
  }
  if (token) return 'truncated';
  if (rootComplete) return 'complete';
  return rootStarted ? 'truncated' : 'invalid';
}
