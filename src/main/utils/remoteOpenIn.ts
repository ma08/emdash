import { quoteShellArg } from './shellEscape';

type RemoteEditorScheme = 'vscode' | 'cursor';

export function buildRemoteSshAuthority(host: string, username: string): string {
  const normalizedHost = host.trim();
  if (!normalizedHost) return normalizedHost;

  // Keep host as-is when caller already included user info (for SSH aliases like user@host).
  if (normalizedHost.includes('@')) return normalizedHost;

  const normalizedUsername = username.trim();
  if (!normalizedUsername) return normalizedHost;

  return `${normalizedUsername}@${normalizedHost}`;
}

export function buildRemoteEditorUrl(
  scheme: RemoteEditorScheme,
  host: string,
  username: string,
  targetPath: string
): string {
  const authority = buildRemoteSshAuthority(host, username);
  const encodedAuthority = encodeURIComponent(authority);
  const normalizedTargetPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  return `${scheme}://vscode-remote/ssh-remote+${encodedAuthority}${normalizedTargetPath}`;
}

type GhosttyRemoteExecInput = {
  host: string;
  username: string;
  port: number | string;
  targetPath: string;
};

/**
 * Builds argv tokens for Ghostty `-e` remote SSH execution.
 *
 * We pass these tokens directly via child_process execFile/spawn (shell disabled),
 * so host/port are not shell-quoted here. The remote command itself is still
 * shell-escaped because it is parsed by the remote shell over SSH.
 */
export function buildGhosttyRemoteExecArgs(input: GhosttyRemoteExecInput): string[] {
  const sshAuthority = buildRemoteSshAuthority(input.host, input.username);
  const remoteCommand = `cd ${quoteShellArg(input.targetPath)} && export TERM=xterm-256color && (exec "\${SHELL:-/bin/bash}" || exec /bin/bash || exec /bin/sh)`;
  return [
    'ssh',
    sshAuthority,
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-p',
    String(input.port),
    '-t',
    remoteCommand,
  ];
}
