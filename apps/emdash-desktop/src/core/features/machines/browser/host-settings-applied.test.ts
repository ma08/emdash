import { describe, expect, it } from 'vitest';
import { assertHostSettingsApplied } from './host-settings-applied';

describe('assertHostSettingsApplied', () => {
  it('accepts a patch the host stored', () => {
    expect(() =>
      assertHostSettingsApplied(
        { multiplexer: 'zellij' },
        { settings: { tmux: true, multiplexer: 'zellij' }, parseError: false }
      )
    ).not.toThrow();
  });

  it('rejects a multiplexer choice an older workspace server dropped', () => {
    expect(() =>
      assertHostSettingsApplied(
        { multiplexer: 'zellij' },
        { settings: { tmux: true }, parseError: false }
      )
    ).toThrow(/does not support choosing a session multiplexer/);
  });

  it('does not check patches that leave the multiplexer alone or clear it', () => {
    const state = { settings: { tmux: true }, parseError: false };

    expect(() => assertHostSettingsApplied({ tmux: true }, state)).not.toThrow();
    expect(() => assertHostSettingsApplied({ multiplexer: null }, state)).not.toThrow();
  });
});
