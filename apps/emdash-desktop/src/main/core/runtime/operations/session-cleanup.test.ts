import { formatHostRef, hostRef, LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { hostFileRefFromNativePath } from '@core/primitives/desktop-runtime/api';
import {
  killLifecycleTerminalSessions,
  type LifecycleSessionTargets,
  type SessionCleanupDependencies,
} from './session-cleanup';

const identity = 'project-1:task-1:terminal-1';
const targets: LifecycleSessionTargets = {
  acpConversationIds: [],
  tuiConversationIds: [],
  terminalSessionIds: [],
  tmuxSessionIdentities: [identity],
};

function setup(killZellijSessions: () => Promise<unknown> = async () => ok(undefined)) {
  const projectTerminals = {
    killTmuxSessions: vi.fn(async () => ok(undefined)),
    killZellijSessions: vi.fn(killZellijSessions),
  };
  const dependencies = {
    getAcpRuntimeClient: vi.fn(),
    getProjectTerminals: vi.fn(() => projectTerminals),
    getTerminalsRuntimeClient: vi.fn(async () => ({ kill: vi.fn(async () => ok(undefined)) })),
    getTuiAgentsRuntimeClient: vi.fn(),
  } as unknown as SessionCleanupDependencies;
  return { dependencies, projectTerminals };
}

describe('killLifecycleTerminalSessions', () => {
  it('cleans up both multiplexers and scopes the zellij lookup to the workspace', async () => {
    const remote = hostRef('remote', 'ssh-1');
    const { dependencies, projectTerminals } = setup();

    await killLifecycleTerminalSessions(
      dependencies,
      {} as never,
      { taskId: 'task-1', projectId: 'project-1', hostRef: formatHostRef(remote) },
      { workspacePath: '/repo/worktree' },
      targets
    );

    expect(projectTerminals.killTmuxSessions).toHaveBeenCalledWith({
      sessionIdentities: [identity],
      workspaceLabel: 'worktree',
    });
    expect(projectTerminals.killZellijSessions).toHaveBeenCalledWith({
      sessionIdentities: [identity],
      workspace: hostFileRefFromNativePath('/repo/worktree', 'ssh-1'),
    });
  });

  it('matches identities as given when the workspace path is unknown', async () => {
    const { dependencies, projectTerminals } = setup();

    await killLifecycleTerminalSessions(
      dependencies,
      {} as never,
      { taskId: 'task-1', projectId: 'project-1', hostRef: formatHostRef(LOCAL_HOST_REF) },
      {},
      targets
    );

    expect(projectTerminals.killZellijSessions).toHaveBeenCalledWith({
      sessionIdentities: [identity],
      workspace: undefined,
    });
  });

  it('tolerates a host whose workspace server has no zellij cleanup procedure', async () => {
    const { dependencies, projectTerminals } = setup(async () => {
      throw new Error('Unknown procedure terminals.killZellijSessions');
    });

    await expect(
      killLifecycleTerminalSessions(
        dependencies,
        {} as never,
        { taskId: 'task-1', projectId: 'project-1', hostRef: formatHostRef(LOCAL_HOST_REF) },
        { workspacePath: '/repo/worktree' },
        targets
      )
    ).resolves.toBeUndefined();
    expect(projectTerminals.killTmuxSessions).toHaveBeenCalledTimes(1);
  });
});
