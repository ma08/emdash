import { createHash } from 'node:crypto';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { log } from '@main/lib/logger';
import { quoteShellArg } from '@main/utils/shellEscape';
import { parsePtySessionId } from '@shared/core/pty/ptySessionId';
import { LIFECYCLE_SCRIPT_TERMINAL_ID_PREFIX } from '@shared/core/terminals/terminals';

export const ZELLIJ_SESSION_PREFIX = 'emdash-';
const DEFAULT_ZELLIJ_LABEL = 'session';
const MAX_ZELLIJ_LABEL_LENGTH = 20;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export type ZellijSessionNameParts = {
  projectHash: string;
  leafKind: 'pty' | 'life';
  leafHash: string;
  sessionHash: string;
};

export type ZellijShellOptions = {
  displayName?: string;
  shell?: string;
  shellArgs?: string[];
};

type ZellijPaneCommand = {
  command: string;
  args: string[];
};

function kdlQuote(value: string): string {
  return JSON.stringify(value);
}

function buildPaneCommand(commandLine: string, options: ZellijShellOptions): ZellijPaneCommand {
  const shell = options.shell?.trim() || '/bin/sh';
  const shellArgs = options.shellArgs?.length ? options.shellArgs : ['-c'];
  return { command: shell, args: [...shellArgs, commandLine] };
}

function buildKdlArgs(args: string[]): string {
  return args.map(kdlQuote).join(' ');
}

function shortHash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, length);
}

export function zellijProjectHash(projectId: string): string {
  return shortHash(projectId, 8);
}

export function zellijLeafHash(leafId: string): string {
  return shortHash(leafId, 10);
}

export function zellijSessionHash(sessionId: string): string {
  return shortHash(sessionId, 8);
}

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

export function makeZellijSessionName(sessionId: string, label?: string): string {
  const parsed = parsePtySessionId(sessionId);
  const projectId = parsed?.projectId ?? 'unknown';
  const leafId = parsed?.leafId ?? sessionId;
  const leafKind = leafId.startsWith(LIFECYCLE_SCRIPT_TERMINAL_ID_PREFIX) ? 'life' : 'pty';
  return [
    `${ZELLIJ_SESSION_PREFIX}${zellijProjectHash(projectId)}`,
    leafKind,
    zellijLeafHash(leafId),
    zellijSessionHash(sessionId),
    makeZellijSessionLabel(label),
  ].join('.');
}

export function parseZellijSessionName(sessionName: string): ZellijSessionNameParts | null {
  if (!sessionName.startsWith(ZELLIJ_SESSION_PREFIX)) return null;
  const [projectHash, leafKind, leafHash, sessionHash] = sessionName
    .slice(ZELLIJ_SESSION_PREFIX.length)
    .split('.');
  if (leafKind !== 'pty' && leafKind !== 'life') return null;
  if (!projectHash || !leafHash || !sessionHash) return null;
  if (projectHash.length !== 8 || leafHash.length !== 10 || sessionHash.length !== 8) {
    return null;
  }
  if (
    !BASE64URL_RE.test(projectHash) ||
    !BASE64URL_RE.test(leafHash) ||
    !BASE64URL_RE.test(sessionHash)
  ) {
    return null;
  }
  return { projectHash, leafKind, leafHash, sessionHash };
}

export function isZellijSessionForPtySessionId(sessionName: string, sessionId: string): boolean {
  const name = parseZellijSessionName(sessionName);
  const parsed = parsePtySessionId(sessionId);
  if (!name || !parsed) return false;
  return (
    name.projectHash === zellijProjectHash(parsed.projectId) &&
    name.leafHash === zellijLeafHash(parsed.leafId) &&
    name.sessionHash === zellijSessionHash(sessionId)
  );
}

export function buildZellijShellLine(
  sessionName: string,
  commandLine: string,
  cwd: string,
  options: ZellijShellOptions = {}
): string {
  const label = options.displayName?.trim() || 'Emdash';
  const paneCommand = buildPaneCommand(commandLine, options);
  const layout = [
    'layout {',
    `  tab name=${kdlQuote(label)} {`,
    `    pane command=${kdlQuote(paneCommand.command)} cwd=${kdlQuote(cwd)} close_on_exit=true focus=true name=${kdlQuote(label)} {`,
    `      args ${buildKdlArgs(paneCommand.args)}`,
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
    `session=${quoteShellArg(sessionName)}`,
    'tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/emdash-zellij.XXXXXX")',
    'layout_file="$tmpdir/layout.kdl"',
    'cleanup() {',
    '  delay="${EMDASH_ZELLIJ_LAYOUT_CLEANUP_DELAY_SECONDS:-30}"',
    '  if [ "$delay" = "0" ]; then',
    '    rm -rf "$tmpdir"',
    '  else',
    '    nohup /bin/sh -c \'sleep "$1"; rm -rf "$2"\' sh "$delay" "$tmpdir" >/dev/null 2>&1 &',
    '  fi',
    '}',
    'finish() {',
    '  finish_status=$?',
    '  trap - EXIT HUP INT TERM',
    '  cleanup',
    '  exit "$finish_status"',
    '}',
    'trap finish EXIT HUP INT TERM',
    `layout=${quoteShellArg(layout)}`,
    'printf \'%s\' "$layout" > "$layout_file"',
    '# Emdash zellij session names are whitespace-free; no-formatting preserves EXITED markers.',
    'active_session_exists() {',
    '  zellij list-sessions --no-formatting 2>/dev/null | awk -v session="$session" \'',
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

  return `/bin/sh -c ${quoteShellArg(script)}`;
}

export async function listEmdashZellijSessions(ctx: IExecutionContext): Promise<string[]> {
  try {
    const { stdout } = await ctx.exec('zellij', ['list-sessions', '--short', '--no-formatting']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name.startsWith(ZELLIJ_SESSION_PREFIX));
  } catch (err) {
    log.debug('listEmdashZellijSessions: no zellij sessions', { error: String(err) });
    return [];
  }
}

export async function killZellijSession(
  ctx: IExecutionContext,
  sessionName: string
): Promise<void> {
  try {
    await ctx.exec('zellij', ['delete-session', '--force', sessionName]);
  } catch (err) {
    log.debug('killZellijSession: zellij session not found or already dead', {
      sessionName,
      error: String(err),
    });
  }
}

export async function killZellijSessionsForPtySessionId(
  ctx: IExecutionContext,
  sessionId: string
): Promise<void> {
  const sessions = await listEmdashZellijSessions(ctx);
  await Promise.all(
    sessions
      .filter((sessionName) => isZellijSessionForPtySessionId(sessionName, sessionId))
      .map((sessionName) => killZellijSession(ctx, sessionName))
  );
}
