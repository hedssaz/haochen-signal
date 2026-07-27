import type {ChildProcess} from 'node:child_process';
import type {Writable} from 'node:stream';

export interface RunCommandInput {
  command: string;
  args?: string[];
  cwd?: string;
  shell?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CommandOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  fullOutputPath?: string;
  outputLogCleanup?: 'sanitized' | 'failed';
}

export interface ProcessController {
  trackTree?(child: ChildProcess, signal?: AbortSignal): void | Promise<void>;
  terminateTree(child: ChildProcess, signal?: AbortSignal): void | Promise<void>;
  forceKillTree(
    child: ChildProcess,
    signal?: AbortSignal,
  ): void | Promise<void>;
  treeExists(
    child: ChildProcess,
    signal?: AbortSignal,
  ): boolean | Promise<boolean>;
  waitForTreeExit(child: ChildProcess, signal?: AbortSignal): Promise<void>;
}

export interface WindowsProcessRecord {
  pid: number;
  parentPid: number;
  creationTime: string;
}

export interface WindowsTaskkillResult {
  exitCode: number | null;
}

export interface WindowsProcessRunner {
  snapshotProcesses(signal?: AbortSignal): Promise<WindowsProcessRecord[]>;
  taskkill(
    pid: number,
    options: {tree: boolean; force: boolean},
    signal?: AbortSignal,
  ): Promise<WindowsTaskkillResult>;
}

export interface CommandTimerController {
  setTimeout(callback: () => void, timeoutMs: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

export interface RunCommandRuntimeOptions {
  createOutputLog?: (path: string) => Promise<Writable>;
  env?: NodeJS.ProcessEnv;
  processController?: ProcessController;
  removeOutputLog?: (path: string) => Promise<void>;
  sanitizeOutputLog?: (path: string) => Promise<void>;
  timers?: CommandTimerController;
}

export type TerminationReason = 'aborted' | 'timeout' | 'output-log-failed';

export interface ProcessOutcome {
  exitCode: number | null;
  spawnError?: unknown;
}
