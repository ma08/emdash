import { createHash } from 'node:crypto';
import { quoteArg, type IExecutionContext } from '#primitives/exec/api';
import { isMissingBinaryFailure, readExecFailure } from './exec-failure';

/**
 * zellij as a persistent-session multiplexer next to tmux (`./tmux.ts`).
 *
 * Session names are `em-<label>.<hash>`: a short human-readable label so users
 * can find the session in `zellij list-sessions`, plus a hash of the PTY
 * session id so every lookup and cleanup can match sessions back to their ids
 * without knowing the label.
 *
 * Names are capped at 22 characters because zellij puts them in a Unix socket
 * path and macOS limits those to 103 bytes: a default `$TMPDIR`
 * (`/var/folders/xx/<30 chars>/T/`, 49) plus zellij's `zellij-<uid>/` (11 or
 * 12) and `contract_version_1/` (19, zellij 0.44) leaves about 24 for the
 * name.
 */
export const ZELLIJ_SESSION_PREFIX = 'em-';
export const ZELLIJ_SESSION_NAME_MAX_LENGTH = 22;
const DEFAULT_ZELLIJ_LABEL = 'session';
const MAX_ZELLIJ_LABEL_LENGTH = 10;
const ZELLIJ_SESSION_HASH_LENGTH = 8;
/** Matches `TMUX_HISTORY_LIMIT`; zellij's default is 10 000 lines. */
const ZELLIJ_SCROLL_BUFFER_SIZE = 100_000;
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

/**
 * KDL v1 quoted string. Escapes are written by hand rather than through
 * `JSON.stringify` so a literal backslash sequence in a prompt (for example
 * the text `\\u001b`) stays literal, while real control characters use KDL's
 * braced `\\u{..}` form.
 */
function kdlQuote(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u{${code.toString(16)}}`;
    else out += char;
  }
  return `${out}"`;
}

function posix(value: string): string {
  return quoteArg(value, 'posix');
}

/**
 * The POSIX attach script for one persistent zellij session, the zellij
 * counterpart of `buildTmuxShellLine`'s inner script.
 *
 * - Sessions are matched by the id hash in their name, not the whole name, so
 *   a session created under an earlier task label is still found after the
 *   task was renamed. An active match is attached as-is (the resumed
 *   conversation keeps its process); `--on-force-close detach` keeps it alive
 *   when the PTY client goes away.
 * - Otherwise `(EXITED)` remnants for the hash are deleted and a fresh session
 *   is created in the foreground from a temporary KDL layout, so the pane
 *   inherits the real terminal size. Resurrecting a remnant would re-run its
 *   stale command line; the caller's current command (with its resume
 *   arguments) must win.
 * - The pane runs `<shell> <shellArgs> <commandLine>` directly, no extra
 *   `/bin/sh` hop, so TUI agents can switch the terminal to raw mode.
 * - A missing `zellij` binary fails fast with exit 127 and a clear message.
 */
export function buildZellijAttachScript(
  sessionName: string,
  commandLine: string,
  cwd: string,
  options: ZellijShellOptions = {}
): string {
  const parsed = parseZellijSessionName(sessionName);
  const label = parsed?.label ?? DEFAULT_ZELLIJ_LABEL;
  const sessionHash = parsed?.sessionHash ?? '';
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

  return [
    'set -eu',
    'if ! command -v zellij >/dev/null 2>&1; then',
    '  echo "Emdash: zellij is not installed or not on PATH" >&2',
    '  exit 127',
    'fi',
    `session=${posix(sessionName)}`,
    `session_hash=${posix(sessionHash)}`,
    'tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/emdash-zellij.XXXXXX")',
    'layout_file="$tmpdir/layout.kdl"',
    'cleanup() {',
    '  delay="${EMDASH_ZELLIJ_LAYOUT_CLEANUP_DELAY_SECONDS:-30}"',
    '  case "$delay" in \'\' | *[!0-9]*) delay=30 ;; esac',
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
    '# Sessions are matched by the id hash so a rename between launches still finds the live session.',
    'list_sessions() {',
    '  zellij list-sessions --no-formatting 2>/dev/null || true',
    '}',
    'active_session_named() {',
    `  list_sessions | awk -v hash="$session_hash" '`,
    `    index($0, "(EXITED") == 0 && $1 ~ ("^${ZELLIJ_SESSION_PREFIX}[a-z0-9-]+[.]" hash "$") { print $1; exit }`,
    "  '",
    '}',
    'delete_remnants() {',
    `  list_sessions | awk -v hash="$session_hash" '`,
    `    index($0, "(EXITED") > 0 && $1 ~ ("^${ZELLIJ_SESSION_PREFIX}[a-z0-9-]+[.]" hash "$") { print $1 }`,
    "  ' | while IFS= read -r remnant; do",
    '    zellij delete-session "$remnant" >/dev/null 2>&1 || true',
    '  done',
    '}',
    'attach_session() {',
    '  zellij attach "$1" options --on-force-close detach',
    '}',
    'create_or_attach_session() {',
    '  delete_remnants',
    `  if zellij attach --create "$session" options --default-layout "$layout_file" --scroll-buffer-size ${ZELLIJ_SCROLL_BUFFER_SIZE} --on-force-close detach; then`,
    '    return 0',
    '  else',
    '    create_status=$?',
    '  fi',
    '  existing=$(active_session_named)',
    '  if [ -n "$existing" ]; then',
    '    attach_session "$existing"',
    '  else',
    '    exit "$create_status"',
    '  fi',
    '}',
    'existing=$(active_session_named)',
    'if [ -n "$existing" ]; then',
    '  if attach_session "$existing"; then',
    '    :',
    '  else',
    '    attach_status=$?',
    '    if [ -n "$(active_session_named)" ]; then',
    '      exit "$attach_status"',
    '    fi',
    '    create_or_attach_session',
    '  fi',
    'else',
    '  create_or_attach_session',
    'fi',
  ].join('\n');
}

/** `/bin/sh -c '<attach script>'`, ready to be the last argument of a shell `-c` invocation. */
export function buildZellijShellLine(
  sessionName: string,
  commandLine: string,
  cwd: string,
  options: ZellijShellOptions = {}
): string {
  return `/bin/sh -c ${posix(buildZellijAttachScript(sessionName, commandLine, cwd, options))}`;
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

/**
 * The listed session that belongs to the same PTY session as `sessionName`
 * and is running, if any. Matching goes through the id hash so a session
 * created under an earlier task label still counts.
 */
export function activeZellijSessionFor(
  sessions: ReadonlyMap<string, ZellijSessionInfo>,
  sessionName: string
): string | undefined {
  const wanted = parseZellijSessionName(sessionName)?.sessionHash;
  if (!wanted) return undefined;
  for (const [name, info] of sessions) {
    if (info.active && parseZellijSessionName(name)?.sessionHash === wanted) return name;
  }
  return undefined;
}

/**
 * Kills the session if it is running and deletes its resurrection data.
 * zellij reports "not found" on stderr for a session that is already gone,
 * and 0.44 does so even after force-deleting a running one, so that outcome
 * counts as success.
 */
export async function killZellijSession(
  ctx: IExecutionContext,
  sessionName: string,
  onError?: (error: unknown) => void
): Promise<void> {
  try {
    await ctx.exec('zellij', ['delete-session', '--force', sessionName]);
  } catch (error) {
    if (/not found/i.test(readExecFailure(error)?.stderr ?? '')) return;
    onError?.(error);
  }
}

/**
 * Kills every listed session (running or exited) that shares `sessionName`'s
 * id hash, which covers sessions created under an earlier task label.
 * Best effort: a listing failure is reported through `onError`, never thrown.
 */
export async function killZellijSessionsMatching(
  ctx: IExecutionContext,
  sessionName: string,
  onError?: (error: unknown) => void
): Promise<void> {
  const wanted = parseZellijSessionName(sessionName)?.sessionHash;
  if (!wanted) {
    await killZellijSession(ctx, sessionName, onError);
    return;
  }
  await killZellijSessionsForHashes(ctx, new Set([wanted]), onError);
}

/**
 * Kills every Emdash zellij session belonging to one of `sessionIds`. Zellij
 * session names carry a label the caller may not know, so matching goes
 * through the embedded PTY session id hash. Best effort like the tmux kill.
 */
export async function killZellijSessionsForPtySessionIds(
  ctx: IExecutionContext,
  sessionIds: readonly string[],
  onError?: (error: unknown) => void
): Promise<void> {
  if (sessionIds.length === 0) return;
  await killZellijSessionsForHashes(ctx, new Set(sessionIds.map(zellijSessionHash)), onError);
}

async function killZellijSessionsForHashes(
  ctx: IExecutionContext,
  hashes: ReadonlySet<string>,
  onError?: (error: unknown) => void
): Promise<void> {
  let sessions: Map<string, ZellijSessionInfo>;
  try {
    sessions = await listZellijSessions(ctx);
  } catch (error) {
    onError?.(error);
    return;
  }
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
