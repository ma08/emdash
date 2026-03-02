import { describe, expect, it } from 'vitest';
import {
  buildGhosttyRemoteExecCommand,
  buildRemoteEditorUrl,
  buildRemoteSshAuthority,
} from '../remoteOpenIn';

describe('buildRemoteSshAuthority', () => {
  it('prepends username when host has no user component', () => {
    expect(buildRemoteSshAuthority('example.internal', 'azureuser')).toBe(
      'azureuser@example.internal'
    );
  });

  it('preserves host when username is already embedded', () => {
    expect(buildRemoteSshAuthority('existing@example.internal', 'azureuser')).toBe(
      'existing@example.internal'
    );
  });
});

describe('buildRemoteEditorUrl', () => {
  it('builds cursor remote URL with encoded user@host authority', () => {
    expect(
      buildRemoteEditorUrl('cursor', 'example.internal', 'azureuser', '/home/azureuser/src')
    ).toBe('cursor://vscode-remote/ssh-remote+azureuser%40example.internal/home/azureuser/src');
  });

  it('normalizes relative target paths with a leading slash', () => {
    expect(buildRemoteEditorUrl('vscode', 'example.internal', 'azureuser', 'workspace')).toBe(
      'vscode://vscode-remote/ssh-remote+azureuser%40example.internal/workspace'
    );
  });
});

describe('buildGhosttyRemoteExecCommand', () => {
  it('builds a single quoted ssh command string for Ghostty -e', () => {
    expect(
      buildGhosttyRemoteExecCommand({
        host: 'example.internal',
        username: 'azureuser',
        port: 22,
        targetPath: '/home/azureuser/pro/smv/.emdash/worktrees/task one',
      })
    ).toBe(
      "ssh 'azureuser@example.internal' -p '22' -t 'cd '\\''/home/azureuser/pro/smv/.emdash/worktrees/task one'\\'' && (exec \"${SHELL:-/bin/sh}\" || exec /bin/sh)'"
    );
  });

  it('preserves an existing user@host authority from host input', () => {
    expect(
      buildGhosttyRemoteExecCommand({
        host: 'ops@example.internal',
        username: 'ignored-user',
        port: '2202',
        targetPath: '/tmp/x',
      })
    ).toContain("ssh 'ops@example.internal' -p '2202' -t ");
  });
});
