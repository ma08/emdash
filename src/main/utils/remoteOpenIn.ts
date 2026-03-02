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
 * Builds a single shell command string for Ghostty `-e` on macOS/Linux.
 *
 * Ghostty remote launch is most reliable when everything after `-e` is a
 * single command string (instead of tokenized argv pieces). The remote command
 * itself is shell-escaped so characters like spaces/parentheses don't break.
 */
export function buildGhosttyRemoteExecCommand(input: GhosttyRemoteExecInput): string {
  const sshAuthority = buildRemoteSshAuthority(input.host, input.username);
  const remoteCommand =
    `cd ${quoteShellArg(input.targetPath)} && ` + '(exec "${SHELL:-/bin/sh}" || exec /bin/sh)';
  return [
    'ssh',
    quoteShellArg(sshAuthority),
    '-p',
    quoteShellArg(String(input.port)),
    '-t',
    quoteShellArg(remoteCommand),
  ].join(' ');
}
