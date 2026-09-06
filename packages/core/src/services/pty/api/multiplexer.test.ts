import { describe, expect, it } from 'vitest';
import { persistentSessionNames } from './multiplexer';
import { makeTmuxSessionName } from './tmux';
import { makeZellijSessionName } from './zellij';

const SESSION_ID = 'project-1:task-1:conversation-1';

describe('persistentSessionNames', () => {
  it('returns no names when persistent sessions are off', () => {
    expect(
      persistentSessionNames({ enabled: false, multiplexer: 'zellij', sessionId: SESSION_ID })
    ).toEqual({});
  });

  it('encodes the id for tmux and ignores the label', () => {
    expect(
      persistentSessionNames({
        enabled: true,
        multiplexer: 'tmux',
        sessionId: SESSION_ID,
        label: 'ignored',
      })
    ).toEqual({ tmuxSessionName: makeTmuxSessionName(SESSION_ID) });
  });

  it('labels the zellij name with the task name', () => {
    expect(
      persistentSessionNames({
        enabled: true,
        multiplexer: 'zellij',
        sessionId: SESSION_ID,
        label: 'Fix Login Bug',
      })
    ).toEqual({ zellijSessionName: makeZellijSessionName(SESSION_ID, 'Fix Login Bug') });
  });
});
