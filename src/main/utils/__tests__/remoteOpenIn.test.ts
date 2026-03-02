import { describe, expect, it } from 'vitest';
import {
  buildGhosttyRemoteExecArgs,
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

describe('buildGhosttyRemoteExecArgs', () => {
  it('builds ssh argv tokens for Ghostty -e', () => {
    expect(
      buildGhosttyRemoteExecArgs({
        host: 'example.internal',
        username: 'azureuser',
        port: 22,
        targetPath: '/home/azureuser/pro/smv/.emdash/worktrees/task one',
      })
    ).toEqual([
      'ssh',
      'azureuser@example.internal',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-p',
      '22',
      '-t',
      `cd '/home/azureuser/pro/smv/.emdash/worktrees/task one' && export TERM=xterm-256color && (exec "\${SHELL:-/bin/bash}" || exec /bin/bash || exec /bin/sh)`,
    ]);
  });

  it('preserves existing user@host authority', () => {
    expect(
      buildGhosttyRemoteExecArgs({
        host: 'ops@example.internal',
        username: 'ignored-user',
        port: '2202',
        targetPath: '/tmp/x',
      })
    ).toEqual([
      'ssh',
      'ops@example.internal',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-p',
      '2202',
      '-t',
      `cd '/tmp/x' && export TERM=xterm-256color && (exec "\${SHELL:-/bin/bash}" || exec /bin/bash || exec /bin/sh)`,
    ]);
  });
});
