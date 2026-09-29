import { createHash } from 'node:crypto';

/**
 * zellij has no per-session metadata store like tmux's user options, so the
 * session identity travels in the name itself: `<label>-<hash>`, the same
 * shape as the readable tmux names. Sessions are found again by the hash, so
 * a session created under an earlier label still belongs to its identity.
 *
 * Names are capped at 22 bytes because zellij puts them in a Unix socket path
 * and macOS limits those to 103 bytes: a default `$TMPDIR`
 * (`/var/folders/xx/<30 chars>/T/`, 49) plus zellij's `zellij-<uid>/` (11 or
 * 12) and `contract_version_1/` (19, zellij 0.44) leaves about 24 for the
 * name. Labels are reduced to ASCII so characters and bytes agree.
 */
export const ZELLIJ_NAME_MAX_LENGTH = 22;
const ZELLIJ_HASH_LENGTH = 10;
const ZELLIJ_NAME_PATTERN = /^(?<label>[a-z0-9][a-z0-9_-]*)-(?<hash>[0-9a-f]{10})$/u;

export function zellijIdentityHash(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, ZELLIJ_HASH_LENGTH);
}

export function makeZellijSessionName(identity: string, label = 'session'): string {
  const maxLabelLength = ZELLIJ_NAME_MAX_LENGTH - ZELLIJ_HASH_LENGTH - 1;
  const truncated = sanitizeZellijSessionLabel(label)
    .slice(0, maxLabelLength)
    .replace(/[-_]+$/u, '');
  return `${truncated || 'session'}-${zellijIdentityHash(identity)}`;
}

/** The readable part of a generated name, used to title the zellij tab and pane. */
export function zellijSessionLabel(sessionName: string): string {
  return ZELLIJ_NAME_PATTERN.exec(sessionName)?.groups?.['label'] ?? 'session';
}

export function zellijSessionBelongsTo(sessionName: string, identity: string): boolean {
  return ZELLIJ_NAME_PATTERN.exec(sessionName)?.groups?.['hash'] === zellijIdentityHash(identity);
}

function sanitizeZellijSessionLabel(label: string): string {
  const sanitized = label
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, '-')
    .replaceAll(/-+/gu, '-')
    .replaceAll(/^[-_]+|[-_]+$/gu, '');
  return sanitized || 'session';
}
