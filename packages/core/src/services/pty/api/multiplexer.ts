import type { SessionMultiplexer } from '#primitives/session-multiplexer/api';
import { makeTmuxSessionName } from './tmux';
import { makeZellijSessionName } from './zellij';

export type PersistentSessionNames = {
  tmuxSessionName?: string;
  zellijSessionName?: string;
};

/**
 * The session-name fields a runtime start input carries for one PTY session:
 * exactly one of them when persistent sessions are enabled, neither otherwise.
 * `label` only shapes the zellij name; tmux names stay pure encodings of the id.
 */
export function persistentSessionNames(input: {
  enabled: boolean;
  multiplexer: SessionMultiplexer;
  sessionId: string;
  label?: string;
}): PersistentSessionNames {
  if (!input.enabled) return {};
  switch (input.multiplexer) {
    case 'tmux':
      return { tmuxSessionName: makeTmuxSessionName(input.sessionId) };
    case 'zellij':
      return { zellijSessionName: makeZellijSessionName(input.sessionId, input.label) };
  }
}
