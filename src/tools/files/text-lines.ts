interface TextLineState {
  pending: string;
}

function consumeTextLines(
  state: TextLineState,
  text: string,
  eof: boolean,
  onLine: (line: string) => void,
): void {
  state.pending += text;
  let start = 0;
  let index = 0;
  while (index < state.pending.length) {
    const character = state.pending[index];
    if (character !== '\r' && character !== '\n') {
      index += 1;
      continue;
    }
    if (character === '\r'
      && index + 1 === state.pending.length
      && !eof) {
      break;
    }

    onLine(state.pending.slice(start, index));
    index += character === '\r' && state.pending[index + 1] === '\n' ? 2 : 1;
    start = index;
  }

  state.pending = state.pending.slice(start);
  if (eof && state.pending.length > 0) {
    onLine(state.pending);
    state.pending = '';
  }
}

export {consumeTextLines};
export type {TextLineState};
