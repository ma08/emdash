/**
 * Persistent-session multiplexers a host can run agent sessions and terminals
 * in. A primitive so settings layers on both the desktop and the workspace
 * server can name the choice without depending on the PTY service.
 */
export const SESSION_MULTIPLEXERS = ['tmux', 'zellij'] as const;

export type SessionMultiplexer = (typeof SESSION_MULTIPLEXERS)[number];

export const DEFAULT_SESSION_MULTIPLEXER: SessionMultiplexer = 'tmux';

/**
 * Workspace-server protocol minor that introduced zellij support (the
 * `zellijSessionName` fields and `killZellijSessions`). Clients gate zellij
 * launches on `agreedMinor >= ZELLIJ_PROTOCOL_MINOR` for remote hosts.
 */
export const ZELLIJ_PROTOCOL_MINOR = 1;

export function isSessionMultiplexer(value: unknown): value is SessionMultiplexer {
  return typeof value === 'string' && (SESSION_MULTIPLEXERS as readonly string[]).includes(value);
}
