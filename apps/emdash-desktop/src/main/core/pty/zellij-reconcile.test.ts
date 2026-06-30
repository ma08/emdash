import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult, IExecutionContext } from '@main/core/execution-context/types';
import { getProjectSessionLeafIds } from '@main/core/tasks/session-targets';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import { createLifecycleScriptTerminalId } from '@shared/core/terminals/terminals';
import { reconcileProjectZellijSessions } from './zellij-reconcile';
import { makeZellijSessionName } from './zellij-session';

vi.mock('@main/core/tasks/session-targets', () => ({
  getProjectSessionLeafIds: vi.fn(),
}));

type ExecCall = { command: string; args: string[] };
type ExecHandler = (command: string, args: string[]) => ExecResult;

function makeCtx(handler: ExecHandler): { ctx: IExecutionContext; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const ctx = {
    root: undefined,
    supportsLocalSpawn: false,
    exec: vi.fn(async (command: string, args: string[] = []) => {
      calls.push({ command, args });
      return handler(command, args);
    }),
    execStreaming: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IExecutionContext;
  return { ctx, calls };
}

function reconcileHandler(sessions: string[]): ExecHandler {
  return (command, args) => {
    if (command === 'zellij' && args[0] === 'list-sessions') {
      return { stdout: `${sessions.join('\n')}\n`, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

function killSessionTargets(calls: ExecCall[]): string[] {
  return calls
    .filter((call) => call.command === 'zellij' && call.args[0] === 'delete-session')
    .map((call) => call.args[2]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reconcileProjectZellijSessions', () => {
  const projectId = 'projA';
  const liveConversation = makeZellijSessionName(
    makePtySessionId(projectId, 't1', 'conv-live'),
    'Claude'
  );
  const liveTerminal = makeZellijSessionName(
    makePtySessionId(projectId, 't1', 'term-live'),
    'Terminal'
  );
  const deadConversation = makeZellijSessionName(
    makePtySessionId(projectId, 't1', 'conv-dead'),
    'Claude'
  );
  const lifecycleSession = makeZellijSessionName(
    makePtySessionId(projectId, 'ws1', createLifecycleScriptTerminalId('run')),
    'Run'
  );
  const otherProjectSession = makeZellijSessionName(
    makePtySessionId('projB', 't1', 'conv-x'),
    'Claude'
  );
  const unparseableSession = 'emdash-label.not*base64url';

  it('reaps only this project orphans, preserving live, lifecycle and foreign sessions', async () => {
    vi.mocked(getProjectSessionLeafIds).mockResolvedValue({
      conversationIds: ['conv-live'],
      terminalIds: ['term-live'],
    });
    const { ctx, calls } = makeCtx(
      reconcileHandler([
        liveConversation,
        liveTerminal,
        deadConversation,
        lifecycleSession,
        otherProjectSession,
        unparseableSession,
      ])
    );

    await reconcileProjectZellijSessions(ctx, projectId);

    expect(killSessionTargets(calls)).toEqual([deadConversation]);
  });

  it('does no DB lookup or kills when the host has no emdash sessions', async () => {
    const { ctx, calls } = makeCtx(() => ({ stdout: '', stderr: '' }));

    await reconcileProjectZellijSessions(ctx, projectId);

    expect(getProjectSessionLeafIds).not.toHaveBeenCalled();
    expect(killSessionTargets(calls)).toEqual([]);
  });

  it('does no DB lookup when every listed session belongs to another project', async () => {
    const { ctx, calls } = makeCtx(reconcileHandler([otherProjectSession, unparseableSession]));

    await reconcileProjectZellijSessions(ctx, projectId);

    expect(getProjectSessionLeafIds).not.toHaveBeenCalled();
    expect(killSessionTargets(calls)).toEqual([]);
  });
});
