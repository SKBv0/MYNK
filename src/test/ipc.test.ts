import { afterEach, describe, expect, it } from 'vitest';
import { call } from '../services/ipc';
import { mockRust, stopRust } from './ipc';

afterEach(() => {
  try {
    stopRust();
  } catch {
    // The test below already asserted on this.
  }
});

describe('the fake backend', () => {
  it('fails the test when a command had no handler', async () => {
    mockRust();
    await expect(call('no_such_command')).rejects.toMatchObject({ kind: 'internal' });
    expect(() => stopRust()).toThrow('no_such_command');
  });

  it('stops without error when every command was served', async () => {
    mockRust();
    await call('get_ai_settings');
    expect(() => stopRust()).not.toThrow();
  });
});
