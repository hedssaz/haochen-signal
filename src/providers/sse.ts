function dataFromFrame(frame: string): string | undefined {
  const dataLines = frame
    .split(/\r\n|\r|\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''));

  return dataLines.length > 0 ? dataLines.join('\n') : undefined;
}

function findFrameBoundary(buffer: string): RegExpExecArray | null {
  return /\r\n\r\n|\r\r|\n\n/.exec(buffer);
}

export async function* decodeSse(
  chunks:
    | AsyncIterable<string | Uint8Array>
    | Iterable<string | Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string'
      ? chunk
      : decoder.decode(chunk, {stream: true});

    let boundary = findFrameBoundary(buffer);
    while (boundary !== null) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = dataFromFrame(frame);
      if (data !== undefined) yield data;
      boundary = findFrameBoundary(buffer);
    }
  }

  buffer += decoder.decode();
  const finalData = dataFromFrame(buffer);
  if (finalData !== undefined) yield finalData;
}
