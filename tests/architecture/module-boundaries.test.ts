import {describe, expect, it} from 'vitest';
import * as filesFacade from '../../src/tools/files.js';
import {
  listFiles,
  readFileTool,
} from '../../src/tools/files/read.js';
import {searchText} from '../../src/tools/files/search.js';
import {applyPatch} from '../../src/tools/files/patch.js';
import {writeFile} from '../../src/tools/files/write.js';
import {
  decodeUtf8Text,
  openVerifiedRegularFile,
} from '../../src/tools/files/file-access.js';
import {validatePatch} from '../../src/tools/files/patch-plan.js';
import {prepareTempFile} from '../../src/tools/files/patch-files.js';
import {executeAdd} from '../../src/tools/files/patch-execute.js';
import * as commandFacade from '../../src/tools/command.js';
import {runCommand} from '../../src/tools/command/run-command.js';
import {
  createWindowsProcessController,
} from '../../src/tools/command/windows-process-tree.js';
import * as boundaryFacade from '../../src/security/boundary.js';
import {
  classifyOperation,
} from '../../src/security/boundary/classify.js';
import {
  unwrapCommand,
} from '../../src/security/boundary/command-policy.js';
import {
  normalizeGitTool,
  normalizeWebTool,
} from '../../src/security/boundary/other-tools.js';

describe('tool module boundaries', () => {
  it('keeps the file tool facade compatible', () => {
    expect(filesFacade.listFiles).toBe(listFiles);
    expect(filesFacade.readFileTool).toBe(readFileTool);
    expect(filesFacade.searchText).toBe(searchText);
    expect(filesFacade.applyPatch).toBe(applyPatch);
    expect(filesFacade.writeFile).toBe(writeFile);
  });

  it('separates shared file access and patch internals', () => {
    expect(openVerifiedRegularFile).toBeTypeOf('function');
    expect(decodeUtf8Text).toBeTypeOf('function');
    expect(validatePatch).toBeTypeOf('function');
    expect(prepareTempFile).toBeTypeOf('function');
    expect(executeAdd).toBeTypeOf('function');
  });

  it('keeps the command tool facade compatible', () => {
    expect(commandFacade.runCommand).toBe(runCommand);
    expect(commandFacade.createWindowsProcessController)
      .toBe(createWindowsProcessController);
  });

  it('keeps the security boundary facade compatible', () => {
    expect(boundaryFacade.classifyOperation).toBe(classifyOperation);
  });

  it('keeps command unwrapping inside the command policy', () => {
    expect(unwrapCommand).toBeTypeOf('function');
  });

  it('keeps every tool policy on the shared context contract', () => {
    expect(normalizeGitTool).toHaveLength(3);
    expect(normalizeWebTool).toHaveLength(3);
  });
});
