import {describe, expect, it} from 'vitest';
import {InteractiveConfirmationBroker} from '../../src/cli/confirmation.js';

const request = {
  operation: {tool: 'apply_patch', input: {operations: []}},
  boundary: {
    action: 'confirm' as const,
    risk: 'high' as const,
    reasons: ['补丁涉及敏感配置'],
    normalizedScope: ['update:.env'],
    fingerprint: 'fingerprint',
  },
};

describe('InteractiveConfirmationBroker', () => {
  it('explicitly denies requests without an interactive terminal', async () => {
    const broker = new InteractiveConfirmationBroker(false);

    await expect(broker.request(request)).resolves.toBe('deny');
    expect(broker.getPending()).toBeUndefined();
  });

  it('publishes an interactive request and resolves the selected permission', async () => {
    const broker = new InteractiveConfirmationBroker(true);
    const result = broker.request(request);

    expect(broker.getPending()).toMatchObject({
      operation: {tool: 'apply_patch'},
      boundary: {risk: 'high'},
    });
    broker.respond('allow_session');

    await expect(result).resolves.toBe('allow_session');
    expect(broker.getPending()).toBeUndefined();
  });
});
