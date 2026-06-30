import type { IExecutionContext } from '@main/core/execution-context/types';
import type { PersistentSessionMultiplexer } from '@shared/core/project-settings/project-settings';
import type { MultiplexerSession } from '@shared/core/pty/session-multiplexer';
import { killTmuxSessionTree } from './tmux-reaper';
import { buildTmuxShellLine, killTmuxSession, makeTmuxSessionName } from './tmux-session-name';
import {
  buildZellijShellLine,
  killZellijSession,
  killZellijSessionsForPtySessionId,
  makeZellijSessionName,
} from './zellij-session';

export type { MultiplexerSession } from '@shared/core/pty/session-multiplexer';

export type MultiplexerShellOptions = {
  shellCommand?: string;
  shellArgs?: string[];
};

export function makeMultiplexerSession(
  kind: MultiplexerSession['kind'],
  sessionId: string,
  displayName?: string,
  stableLabel?: string
): MultiplexerSession {
  return {
    kind,
    sessionName:
      kind === 'tmux'
        ? makeTmuxSessionName(sessionId)
        : makeZellijSessionName(sessionId, stableLabel ?? displayName),
    ...(displayName?.trim() ? { displayName: displayName.trim() } : {}),
  };
}

export function buildMultiplexerShellLine(
  session: MultiplexerSession,
  commandLine: string,
  cwd: string,
  options: MultiplexerShellOptions = {}
): string {
  switch (session.kind) {
    case 'tmux':
      return buildTmuxShellLine(session.sessionName, commandLine);
    case 'zellij':
      return buildZellijShellLine(session.sessionName, commandLine, cwd, {
        displayName: session.displayName,
        shell: options.shellCommand,
        shellArgs: options.shellArgs,
      });
  }
}

export async function killMultiplexerSession(
  ctx: IExecutionContext,
  session: MultiplexerSession
): Promise<void> {
  switch (session.kind) {
    case 'tmux':
      await killTmuxSession(ctx, session.sessionName);
      return;
    case 'zellij':
      await killZellijSession(ctx, session.sessionName);
      return;
  }
}

export async function killMultiplexerSessionTree(
  ctx: IExecutionContext,
  session: MultiplexerSession
): Promise<void> {
  switch (session.kind) {
    case 'tmux':
      await killTmuxSessionTree(ctx, session.sessionName);
      return;
    case 'zellij':
      await killZellijSession(ctx, session.sessionName);
      return;
  }
}

export async function killMultiplexerSessionsForPtySessionId(
  ctx: IExecutionContext,
  kind: PersistentSessionMultiplexer,
  sessionId: string,
  options: { tree?: boolean } = {}
): Promise<void> {
  switch (kind) {
    case 'tmux':
      if (options.tree) {
        await killTmuxSessionTree(ctx, makeTmuxSessionName(sessionId));
      } else {
        await killTmuxSession(ctx, makeTmuxSessionName(sessionId));
      }
      return;
    case 'zellij':
      await killZellijSessionsForPtySessionId(ctx, sessionId);
      return;
  }
}
