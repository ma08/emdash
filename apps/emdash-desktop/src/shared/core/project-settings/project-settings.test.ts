import { describe, expect, it } from 'vitest';
import {
  resolveDefaultSessionMultiplexer,
  withSessionMultiplexerCompatibility,
} from './project-settings';

describe('session multiplexer project settings compatibility', () => {
  it('keeps legacy tmuxByDefault true unless a canonical default is set', () => {
    expect(resolveDefaultSessionMultiplexer({ tmuxByDefault: true })).toBe('tmux');
    expect(
      resolveDefaultSessionMultiplexer({
        tmuxByDefault: true,
        sessionMultiplexerByDefault: 'none',
      })
    ).toBe('none');
    expect(
      resolveDefaultSessionMultiplexer({
        tmuxByDefault: true,
        sessionMultiplexerByDefault: 'zellij',
      })
    ).toBe('zellij');
  });

  it('mirrors legacy tmux and lets canonical sessionMultiplexer win', () => {
    expect(withSessionMultiplexerCompatibility({ tmux: true })).toMatchObject({
      sessionMultiplexer: 'tmux',
      tmux: true,
    });
    expect(
      withSessionMultiplexerCompatibility({ tmux: true, sessionMultiplexer: 'zellij' })
    ).toMatchObject({
      sessionMultiplexer: 'zellij',
      tmux: false,
    });
  });
});
