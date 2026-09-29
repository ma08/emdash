import { quoteArg, type IExecutionContext } from '#primitives/exec/api';
import { readExecFailure } from './tmux-commands';
import { zellijSessionLabel } from './zellij-identity';

/** Matches `TMUX_HISTORY_LIMIT`; zellij's default is 10 000 lines. */
const ZELLIJ_SCROLL_BUFFER_SIZE = 100_000;
/**
 * `list-sessions` probes every session socket and `delete-session` talks to
 * the session's server; a wedged session must not stall callers.
 */
const ZELLIJ_EXEC_TIMEOUT_MS = 10_000;

export type ZellijSessionInventoryEntry = {
  name: string;
  /** False for sessions zellij lists as `(EXITED …)`: resurrectable, but no live process. */
  active: boolean;
};

export type ZellijShellOptions = {
  /** Shell that runs the pane command; defaults to `/bin/sh`. */
  shell?: string;
  /** Arguments that make `shell` run a command line; defaults to `-c`. */
  shellArgs?: readonly string[];
  /** Quoting family of the shell that receives the whole line; defaults to posix. */
  outerShellFamily?: 'posix' | 'csh';
};

/**
 * KDL v1 quoted string. Escapes are written by hand rather than through
 * `JSON.stringify` so a literal backslash sequence in a prompt stays literal,
 * while real control characters use KDL's braced `\u{..}` form.
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
 * counterpart of `buildTmuxShellLine`'s inner script. It is a single line:
 * the outer shell that receives it may be csh, which rejects newlines inside
 * quotes, and the layout is written with one `printf '%s\n'` argument per
 * line for the same reason.
 *
 * - A running session is attached as-is so a resumed conversation keeps its
 *   process; `--on-force-close detach` keeps it alive when the PTY client
 *   goes away.
 * - Otherwise a fresh session is created in the foreground from a temporary
 *   KDL layout, so the pane inherits the real terminal size. The layout holds
 *   the command line, so it is written only when a session is created and
 *   removed when the client exits. An `(EXITED)`
 *   remnant under the same name is deleted first: resurrecting it would
 *   re-run its stale command line, and the caller's current command (with its
 *   resume arguments) must win. A remnant that survives deletion aborts the
 *   launch instead of being resurrected.
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
  const label = zellijSessionLabel(sessionName);
  const shell = options.shell?.trim() || '/bin/sh';
  const shellArgs = options.shellArgs?.length ? [...options.shellArgs] : ['-c'];
  const layoutLines = [
    'layout {',
    `  tab name=${kdlQuote(label)} {`,
    `    pane command=${kdlQuote(shell)} cwd=${kdlQuote(cwd)} close_on_exit=true focus=true name=${kdlQuote(label)} {`,
    `      args ${[...shellArgs, commandLine].map(kdlQuote).join(' ')}`,
    '    }',
    '  }',
    '}',
  ];

  return [
    'set -eu',
    'if ! command -v zellij >/dev/null 2>&1; then echo "Emdash: zellij is not installed or not on PATH" >&2; exit 127; fi',
    `session=${posix(sessionName)}`,
    'tmpdir=""',
    'cleanup() { if [ -z "$tmpdir" ]; then return 0; fi; delay="${EMDASH_ZELLIJ_LAYOUT_CLEANUP_DELAY_SECONDS:-30}"; case "$delay" in \'\' | *[!0-9]*) delay=30 ;; esac; if [ "$delay" = "0" ]; then rm -rf "$tmpdir"; else nohup /bin/sh -c \'sleep "$1"; rm -rf "$2"\' sh "$delay" "$tmpdir" >/dev/null 2>&1 & fi; }',
    'finish() { finish_status=$?; trap - EXIT HUP INT TERM; cleanup; exit "$finish_status"; }',
    'trap finish EXIT HUP INT TERM',
    `write_layout() { tmpdir=$(mktemp -d "\${TMPDIR:-/tmp}/emdash-zellij.XXXXXX"); layout_file="$tmpdir/layout.kdl"; printf '%s\\n' ${layoutLines.map(posix).join(' ')} > "$layout_file"; }`,
    // Session names are whitespace-free; --no-formatting keeps the EXITED marker parseable.
    'session_state() { { zellij list-sessions --no-formatting 2>/dev/null || true; } | awk -v session="$session" \'$1 == session { print (index($0, "(EXITED") > 0 ? "exited" : "active"); exit }\'; }',
    'attach_session() { zellij attach "$session" options --on-force-close detach; }',
    `create_session() { if [ "$(session_state)" = "exited" ]; then zellij delete-session "$session" >/dev/null 2>&1 || true; if [ "$(session_state)" = "exited" ]; then echo "Emdash: could not delete the stale zellij session $session" >&2; exit 1; fi; fi; write_layout; if zellij attach --create "$session" options --default-layout "$layout_file" --scroll-buffer-size ${ZELLIJ_SCROLL_BUFFER_SIZE} --on-force-close detach; then return 0; else create_status=$?; fi; if [ "$(session_state)" = "active" ]; then attach_session; else exit "$create_status"; fi; }`,
    'if [ "$(session_state)" = "active" ]; then if attach_session; then :; else attach_status=$?; if [ "$(session_state)" = "active" ]; then exit "$attach_status"; fi; create_session; fi; else create_session; fi',
  ].join('; ');
}

/**
 * `/bin/sh -c '<attach script>'`, ready to be the last argument of a shell
 * `-c` invocation. `outerShellFamily` picks the quoting for the shell that
 * receives the line: csh needs `!` escaped.
 */
export function buildZellijShellLine(
  sessionName: string,
  commandLine: string,
  cwd: string,
  options: ZellijShellOptions = {}
): string {
  const script = buildZellijAttachScript(sessionName, commandLine, cwd, options);
  return `/bin/sh -c ${quoteArg(script, options.outerShellFamily ?? 'posix')}`;
}

export async function listZellijSessions(
  ctx: IExecutionContext
): Promise<ZellijSessionInventoryEntry[]> {
  try {
    const result = await ctx.exec('zellij', ['list-sessions', '--no-formatting'], {
      timeout: ZELLIJ_EXEC_TIMEOUT_MS,
    });
    return parseZellijSessionInventory(result.stdout);
  } catch (error) {
    if (isExpectedZellijListFailure(error)) return [];
    throw error;
  }
}

/** Kills the session if it is running and deletes its resurrection data. */
export async function killZellijSession(
  ctx: IExecutionContext,
  sessionName: string,
  onError?: (error: unknown) => void
): Promise<void> {
  try {
    await ctx.exec('zellij', ['delete-session', '--force', sessionName], {
      timeout: ZELLIJ_EXEC_TIMEOUT_MS,
    });
  } catch (error) {
    // zellij reports "not found" for a session that is already gone, and 0.44
    // does so even after force-deleting a running one.
    if (/not found/i.test(readExecFailure(error)?.stderr ?? '')) return;
    onError?.(error);
  }
}

/**
 * Session lines look like `name [Created 2h 3m ago] (EXITED - attach to
 * resurrect)`; informational output such as "No active zellij sessions
 * found." carries no `[Created` marker and yields no entry.
 */
export function parseZellijSessionInventory(output: string): ZellijSessionInventoryEntry[] {
  const sessions: ZellijSessionInventoryEntry[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.includes('[Created')) continue;
    const name = trimmed.split(/\s+/u, 1)[0];
    if (!name) continue;
    sessions.push({ name, active: !trimmed.includes('(EXITED') });
  }
  return sessions;
}

function isExpectedZellijListFailure(error: unknown): boolean {
  const failure = readExecFailure(error);
  if (!failure) return false;
  if (failure.executableMissing) return true;
  if (/no active zellij sessions found/i.test(failure.stderr)) return true;
  return failure.exitCode === 127;
}
