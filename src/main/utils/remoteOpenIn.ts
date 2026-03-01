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
