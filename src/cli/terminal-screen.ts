export interface TerminalOutput {
  isTTY?: boolean;
  write(text: string): unknown;
}

const clearScreenAndScrollback = '\u001B[2J\u001B[3J\u001B[H';

export function clearTerminalScreen(output: TerminalOutput): void {
  if (output.isTTY) output.write(clearScreenAndScrollback);
}
