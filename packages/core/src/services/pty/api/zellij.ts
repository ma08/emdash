import { createHash } from 'node:crypto';
import { quoteArg, type IExecutionContext } from '#primitives/exec/api';
import { isMissingBinaryFailure, readExecFailure } from './exec-failure';

/**
 * zellij as a persistent-session multiplexer next to tmux (`./tmux.ts`).
 *
 * Session names are `emdash-<label>.<hash>`: a short human-readable label so
 * users can find the session in `zellij list-sessions`, plus a hash of the PTY
 * session id so desktop cleanup can match sessions back to their ids without
 * knowing the label. Names stay short because zellij places them in socket
 * paths.
 */
export const ZELLIJ_SESSION_PREFIX = 'emdash-';
const DEFAULT_ZELLIJ_LABEL = 'session';
const MAX_ZELLIJ_LABEL_LENGTH = 20;
const ZELLIJ_SESSION_HASH_LENGTH = 10;
const SESSION_HASH_RE = /^[A-Za-z0-9_-]+$/;
const SESSION_LABEL_RE = /^[a-z0-9-]+$/;

export type ZellijSessionNameParts = { label: string; sessionHash: string };

export type ZellijSessionInfo = {
  /** False for sessions zellij lists as `(EXITED …)`: resurrectable, but no live process. */
  active: boolean;
};

export type ZellijShellOptions = {
  /** Shell that runs the pane command; defaults to `/bin/sh`. */
  shell?: string;
  /** Arguments that make `shell` run a command line; defaults to `-c`. */
  shellArgs?: readonly string[];
};

export function makeZellijSessionLabel(value: string | undefined): string {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ZELLIJ_LABEL_LENGTH)
    .replace(/-+$/g, '');
  return normalized || DEFAULT_ZELLIJ_LABEL;
}

export function zellijSessionHash(sessionId: string): string {
  return createHash('sha256')
    .update(sessionId)
    .digest('base64url')
    .slice(0, ZELLIJ_SESSION_HASH_LENGTH);
}

export function makeZellijSessionName(sessionId: string, label?: string): string {
  return `${ZELLIJ_SESSION_PREFIX}${makeZellijSessionLabel(label)}.${zellijSessionHash(sessionId)}`;
}

export function parseZellijSessionName(sessionName: string): ZellijSessionNameParts | null {
  if (!sessionName.startsWith(ZELLIJ_SESSION_PREFIX)) return null;
  const rest = sessionName.slice(ZELLIJ_SESSION_PREFIX.length);
  const separator = rest.lastIndexOf('.');
  if (separator <= 0) return null;
  const label = rest.slice(0, separator);
  const sessionHash = rest.slice(separator + 1);
  if (sessionHash.length !== ZELLIJ_SESSION_HASH_LENGTH || !SESSION_HASH_RE.test(sessionHash)) {
    return null;
  }
  if (!SESSION_LABEL_RE.test(label)) return null;
  return { label, sessionHash };
}

export function isZellijSessionForPtySessionId(sessionName: string, sessionId: string): boolean {
  const parsed = parseZellijSessionName(sessionName);
  return parsed !== null && parsed.sessionHash === zellijSessionHash(sessionId);
}

function kdlQuote(value: string): string {
  return JSON.stringify(value);
}

function posix(value: string): string {
  return quoteArg(value, 'posix');
}

/**
 * POSIX wrapper that attaches the pane command to a persistent zellij session,
 * the zellij counterpart of `buildTmuxShellLine`.
 *
 * - An active session is attached as-is so a resumed conversation keeps its
 *   process. `--on-force-close detach` keeps the session alive when the PTY
 *   client goes away.
 * - Otherwise any `(EXITED)` remnant is deleted and a fresh session is created
 *   in the foreground from a temporary KDL layout, so the pane inherits the
 *   real terminal size instead of zellij's detached default. Resurrecting the
 *   remnant would re-run the stale command line; the caller's current command
 *   (with its resume arguments) must win.
 * - The pane runs `<shell> <shellArgs> <commandLine>` directly, no extra
 *   `/bin/sh` hop, so TUI agents can switch the terminal to raw mode.
 * - A missing `zellij` binary fails fast with exit 127 and a clear message.
 */
export function buildZellijShellLine(
  sessionName: string,
  commandLine: string,
  cwd: string,
  options: ZellijShellOptions = {}
): string {
  const label = parseZellijSessionName(sessionName)?.label ?? DEFAULT_ZELLIJ_LABEL;
  const shell = options.shell?.trim() || '/bin/sh';
  const shellArgs = options.shellArgs?.length ? [...options.shellArgs] : ['-c'];
  const layout = [
    'layout {',
    `  tab name=${kdlQuote(label)} {`,
    `    pane command=${kdlQuote(shell)} cwd=${kdlQuote(cwd)} close_on_exit=true focus=true name=${kdlQuote(label)} {`,
    `      args ${[...shellArgs, commandLine].map(kdlQuote).join(' ')}`,
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  const script = [
    'set -eu',
    'if ! command -v zellij >/dev/null 2>&1; then',
    '  echo "Emdash: zellij is not installed or not on PATH" >&2',
    '  exit 127',
    'fi',
    `session=${posix(sessionName)}`,
    'tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/emdash-zellij.XXXXXX")',
    'layout_file="$tmpdir/layout.kdl"',
    'cleanup() {',
    '  delay="${EMDASH_ZELLIJ_LAYOUT_CLEANUP_DELAY_SECONDS:-30}"',
    '  if [ "$delay" = "0" ]; then',
    '    rm -rf "$tmpdir"',
    '  else',
    `    nohup /bin/sh -c 'sleep "$1"; rm -rf "$2"' sh "$delay" "$tmpdir" >/dev/null 2>&1 &`,
    '  fi',
    '}',
    'finish() {',
    '  finish_status=$?',
    '  trap - EXIT HUP INT TERM',
    '  cleanup',
    '  exit "$finish_status"',
    '}',
    'trap finish EXIT HUP INT TERM',
    `layout=${posix(layout)}`,
    `printf '%s' "$layout" > "$layout_file"`,
    '# Emdash zellij session names are whitespace-free; no-formatting keeps the EXITED marker parseable.',
    'active_session_exists() {',
    `  zellij list-sessions --no-formatting 2>/dev/null | awk -v session="$session" '`,
    '    $1 == session && index($0, "(EXITED") == 0 { found = 1 }',
    '    END { exit found ? 0 : 1 }',
    "  '",
    '}',
    'create_or_attach_session() {',
    '  zellij delete-session "$session" >/dev/null 2>&1 || true',
    '  if zellij attach --create "$session" options --default-layout "$layout_file" --on-force-close detach; then',
    '    return 0',
    '  else',
    '    create_status=$?',
    '  fi',
    '  if active_session_exists; then',
    '    zellij attach "$session" options --on-force-close detach',
    '  else',
    '    exit "$create_status"',
    '  fi',
    '}',
    'if active_session_exists; then',
    '  if zellij attach "$session" options --on-force-close detach; then',
    '    :',
    '  else',
    '    attach_status=$?',
    '    if active_session_exists; then',
    '      exit "$attach_status"',
    '    fi',
    '    create_or_attach_session',
    '  fi',
    'else',
    '  create_or_attach_session',
    'fi',
  ].join('\n');

  return `/bin/sh -c ${posix(script)}`;
}

/**
 * Emdash-owned zellij sessions on this host, keyed by name. Only names carrying
 * the Emdash prefix are returned; zellij's informational output (for example
 * "No active zellij sessions found.") never yields entries.
 */
export async function listZellijSessions(
  ctx: IExecutionContext
): Promise<Map<string, ZellijSessionInfo>> {
  try {
    const result = await ctx.exec('zellij', ['list-sessions', '--no-formatting']);
    return parseZellijSessionList(result.stdout);
  } catch (error) {
    if (isExpectedZellijListFailure(error)) return new Map();
    throw error;
  }
}

export function parseZellijSessionList(output: string): Map<string, ZellijSessionInfo> {
  const sessions = new Map<string, ZellijSessionInfo>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const name = trimmed.split(/\s+/, 1)[0];
    if (!name?.startsWith(ZELLIJ_SESSION_PREFIX)) continue;
    sessions.set(name, { active: !trimmed.includes('(EXITED') });
  }
  return sessions;
}

/** Kills the session if it is running and deletes its resurrection data. */
export async function killZellijSession(
  ctx: IExecutionContext,
  sessionName: string,
  onError?: (error: unknown) => void
): Promise<void> {
  try {
    await ctx.exec('zellij', ['delete-session', '--force', sessionName]);
  } catch (error) {
    onError?.(error);
  }
}

/**
 * Kills every Emdash zellij session belonging to one of `sessionIds`. Zellij
 * session names carry a label the caller may not know, so matching goes
 * through the embedded PTY session id hash.
 */
export async function killZellijSessionsForPtySessionIds(
  ctx: IExecutionContext,
  sessionIds: readonly string[],
  onError?: (error: unknown) => void
): Promise<void> {
  if (sessionIds.length === 0) return;
  const hashes = new Set(sessionIds.map(zellijSessionHash));
  const sessions = await listZellijSessions(ctx);
  const matches = [...sessions.keys()].filter((name) => {
    const parsed = parseZellijSessionName(name);
    return parsed !== null && hashes.has(parsed.sessionHash);
  });
  await Promise.all(matches.map((name) => killZellijSession(ctx, name, onError)));
}

function isExpectedZellijListFailure(error: unknown): boolean {
  const failure = readExecFailure(error);
  if (!failure) return false;
  if (/no active zellij sessions found/i.test(failure.stderr)) return true;
  return isMissingBinaryFailure(failure);
}
