import type {ChildProcess} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

export function signalPosixProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between the state check and the signal.
    }
  }
}

export function processGroupExists(child: ChildProcess): boolean {
  if (process.platform === 'win32' || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export async function waitForProcessGroupExit(child: ChildProcess): Promise<void> {
  while (processGroupExists(child)) {
    await delay(10);
  }
}
