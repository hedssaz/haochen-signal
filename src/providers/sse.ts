function dataFromFrame(frame: string): string | undefined {
  const dataLines = frame
    .split(/\r\n|\r|\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''));

  return dataLines.length > 0 ? dataLines.join('\n') : undefined;
}

interface LineEnding {
  index: number;
  length: number;
}

interface FrameBoundary {
  frameEnd: number;
  nextIndex: number;
}

function findLineEnding(
  buffer: string,
  start: number,
  endOfStream: boolean,
): LineEnding | undefined {
  for (let index = start; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (character === '\n') return {index, length: 1};
    if (character !== '\r') continue;
    if (index + 1 === buffer.length && !endOfStream) return undefined;
    return {
      index,
      length: buffer[index + 1] === '\n' ? 2 : 1,
    };
  }

  return undefined;
}

function findFrameBoundary(
  buffer: string,
  endOfStream: boolean,
): FrameBoundary | undefined {
  let lineStart = 0;

  while (true) {
    const ending = findLineEnding(buffer, lineStart, endOfStream);
    if (ending === undefined) return undefined;
    if (ending.index === lineStart) {
      return {
        frameEnd: lineStart,
        nextIndex: ending.index + ending.length,
      };
    }
    lineStart = ending.index + ending.length;
  }
}

function takeCompleteFrames(
  input: string,
  endOfStream: boolean,
): {frames: string[]; remainder: string} {
  const frames: string[] = [];
  let remainder = input;
  let boundary = findFrameBoundary(remainder, endOfStream);

  while (boundary !== undefined) {
    frames.push(remainder.slice(0, boundary.frameEnd));
    remainder = remainder.slice(boundary.nextIndex);
    boundary = findFrameBoundary(remainder, endOfStream);
  }

  return {frames, remainder};
}

export async function* decodeSse(
  chunks:
    | AsyncIterable<string | Uint8Array>
    | Iterable<string | Uint8Array>,
  options: {requireCompleteFinalFrame?: boolean} = {},
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string'
      ? chunk
      : decoder.decode(chunk, {stream: true});

    const {frames, remainder} = takeCompleteFrames(buffer, false);
    buffer = remainder;
    for (const frame of frames) {
      const data = dataFromFrame(frame);
      if (data !== undefined) yield data;
    }
  }

  buffer += decoder.decode();
  const {frames, remainder} = takeCompleteFrames(buffer, true);
  buffer = remainder;
  for (const frame of frames) {
    const data = dataFromFrame(frame);
    if (data !== undefined) yield data;
  }
  if (options.requireCompleteFinalFrame && buffer.length > 0) {
    throw new Error('SSE stream ended with an incomplete SSE frame');
  }
  const finalData = dataFromFrame(buffer);
  if (finalData !== undefined) yield finalData;
}
