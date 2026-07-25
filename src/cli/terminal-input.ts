import {createInterface} from 'node:readline/promises';
import type {FirstRunInput} from './first-run.js';

interface TtyInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export function createFirstRunInput(
  input: TtyInput,
  output: NodeJS.WritableStream,
): FirstRunInput & {close(): void} {
  const terminal = createInterface({input, output});

  return {
    read: async (prompt: string, options?: {hidden?: boolean}): Promise<string> => {
      if (!options?.hidden || !input.isTTY || input.setRawMode === undefined) {
        return terminal.question(prompt);
      }

      terminal.pause();
      output.write(prompt);
      return new Promise(resolve => {
        let value = '';
        const finish = (nextValue: string) => {
          input.off('data', onData);
          input.setRawMode?.(false);
          terminal.resume();
          resolve(nextValue);
        };
        const onData = (chunk: Buffer | string) => {
          const text = chunk.toString();
          if (text === '\r' || text === '\n') {
            output.write('\n');
            finish(value);
          } else if (text === '\u0003') {
            finish('');
          } else if (text === '\u007f') {
            value = value.slice(0, -1);
          } else {
            value += text;
          }
        };

        input.setRawMode?.(true);
        input.on('data', onData);
        input.resume();
      });
    },
    close: () => terminal.close(),
  };
}
