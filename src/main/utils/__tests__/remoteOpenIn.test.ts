import { describe, expect, it } from 'vitest';
import { buildRemoteEditorUrl, buildRemoteSshAuthority } from '../remoteOpenIn';

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
