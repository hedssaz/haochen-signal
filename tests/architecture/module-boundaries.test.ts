import {describe, expect, it} from 'vitest';
import * as filesFacade from '../../src/tools/files.js';
import {
  listFiles,
  readFileTool,
} from '../../src/tools/files/read.js';
import {searchText} from '../../src/tools/files/search.js';
import {applyPatch} from '../../src/tools/files/patch.js';
import {writeFile} from '../../src/tools/files/write.js';

describe('tool module boundaries', () => {
  it('keeps the file tool facade compatible', () => {
    expect(filesFacade.listFiles).toBe(listFiles);
    expect(filesFacade.readFileTool).toBe(readFileTool);
    expect(filesFacade.searchText).toBe(searchText);
    expect(filesFacade.applyPatch).toBe(applyPatch);
    expect(filesFacade.writeFile).toBe(writeFile);
  });
});
