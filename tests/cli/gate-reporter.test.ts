import {describe, expect, it, vi} from 'vitest';
import {GateReporter} from '../../src/cli/gate-reporter.js';
import type {ToolGateEvent} from '../../src/tools/types.js';

const event: ToolGateEvent = {
  type: 'gate_finished',
  tool: 'read_file',
  outcome: 'execute',
  source: 'boundary_allow',
  summary: '无需 AI 审查，确定性边界直接放行',
};

describe('GateReporter', () => {
  it('delivers gate events to every subscriber', () => {
    const reporter = new GateReporter();
    const first = vi.fn();
    const second = vi.fn();
    reporter.subscribe(first);
    reporter.subscribe(second);

    reporter.report(event);

    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
  });

  it('isolates a throwing subscriber', () => {
    const reporter = new GateReporter();
    const healthy = vi.fn();
    reporter.subscribe(() => { throw new Error('offline'); });
    reporter.subscribe(healthy);

    expect(() => reporter.report(event)).not.toThrow();
    expect(healthy).toHaveBeenCalledWith(event);
  });
});
