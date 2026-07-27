import type {open} from 'node:fs/promises';

export interface ListFilesInput {
  path?: string;
}

export interface ListFilesOutput {
  files: string[];
}

export interface SearchTextInput {
  query: string;
  path?: string;
  maxMatches?: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface SearchTextOutput {
  matches: SearchMatch[];
}

export interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
  startCharacter?: number;
  maxCharacters?: number;
}

export interface ReadFileOutput {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  startCharacter: number;
  endCharacter: number;
  totalCharacters: number;
  nextCharacter?: number;
}

export type PatchOperation =
  | {type: 'add'; path: string; content: string}
  | {type: 'update'; path: string; expected: string; replacement: string}
  | {type: 'delete'; path: string; sha256: string};

export interface ApplyPatchInput {
  operations: PatchOperation[];
}

export interface WriteFileInput {
  path: string;
  content: string;
}

export interface WriteFileOutput {
  path: string;
  additions: number;
  bytesWritten: number;
  warnings?: string[];
}

export interface FileChange {
  path: string;
  type: PatchOperation['type'];
  additions: number;
  deletions: number;
}

export interface ApplyPatchOutput {
  changes: FileChange[];
  warnings?: string[];
}

type OpenFileHandle = Awaited<ReturnType<typeof open>>;

export interface PatchFileOperations {
  write(file: OpenFileHandle, contents: Buffer): Promise<void>;
  truncate(file: OpenFileHandle, length: number): Promise<void>;
  sync(file: OpenFileHandle): Promise<void>;
  chmod(file: OpenFileHandle, mode: number): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  close(file: OpenFileHandle): Promise<void>;
}
