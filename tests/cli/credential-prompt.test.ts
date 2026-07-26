import {describe, expect, it} from 'vitest';
import {
  InteractiveCredentialPromptBroker,
} from '../../src/cli/credential-prompt.js';

const provider = {
  id: 'deepseek',
  name: 'DeepSeek',
  credentialRef: 'deepseek-credential',
};

describe('InteractiveCredentialPromptBroker', () => {
  it('does not open a prompt without an interactive terminal', async () => {
    const broker = new InteractiveCredentialPromptBroker(false);

    await expect(broker.request(provider, new AbortController().signal))
      .resolves.toBeUndefined();
    expect(broker.getPending()).toBeUndefined();
  });

  it('publishes only provider metadata and resolves the submitted key', async () => {
    const broker = new InteractiveCredentialPromptBroker(true);
    const result = broker.request(provider, new AbortController().signal);

    expect(broker.getPending()).toMatchObject({
      provider: {id: 'deepseek', name: 'DeepSeek'},
    });
    expect(JSON.stringify(broker.getPending())).not.toContain('secret');
    broker.respond(' provider-secret ');

    await expect(result).resolves.toBe('provider-secret');
    expect(broker.getPending()).toBeUndefined();
  });

  it('rejects and clears a pending prompt when the task is aborted', async () => {
    const broker = new InteractiveCredentialPromptBroker(true);
    const controller = new AbortController();
    const result = broker.request(provider, controller.signal);

    controller.abort(new DOMException('用户中止', 'AbortError'));

    await expect(result).rejects.toMatchObject({name: 'AbortError'});
    expect(broker.getPending()).toBeUndefined();
  });
});
