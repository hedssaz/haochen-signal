import {describe, expect, it} from 'vitest';
import {
  CLI_NAME,
  PACKAGE_NAME,
  PRODUCT_ENGLISH_NAME,
  PRODUCT_NAME,
} from '../src/meta.js';

describe('product metadata', () => {
  it('uses the approved Haochen identity', () => {
    expect(PRODUCT_NAME).toBe('浩宸信号');
    expect(PRODUCT_ENGLISH_NAME).toBe('Haochen Signal');
    expect(PACKAGE_NAME).toBe('haochen-signal');
    expect(CLI_NAME).toBe('haochen');
  });
});
