import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '#primitives/exec/api';
import {
  activeZellijSessionFor,
  buildZellijAttachScript,
  buildZellijShellLine,
  isZellijSessionForPtySessionId,
  killZellijSession,
  killZellijSessionsForPtySessionIds,
  killZellijSessionsMatching,
  listZellijSessions,
  makeZellijSessionLabel,
  makeZellijSessionName,
  parseZellijSessionList,
  parseZellijSessionName,
  ZELLIJ_SESSION_NAME_MAX_LENGTH,
  zellijSessionHash,
} from './zellij';

const SESSION_ID = 'project-1:task-1:conversation-1';

describe('makeZellijSessionName', () => {
  it('combines a readable label with a short deterministic session hash', () => {
    const name = makeZellijSessionName(SESSION_ID, 'Fix login bug');

    expect(name).toBe(`em-fix-login.${zellijSessionHash(SESSION_ID)}`);
    expect(name).toMatch(/^em-[a-z0-9-]+\.[A-Za-z0-9_-]{8}$/);
    expect(makeZellijSessionName(SESSION_ID, 'Fix login bug')).toBe(name);
    expect(makeZellijSessionName('project-1:task-1:conversation-2', 'Fix login bug')).not.toBe(
      name
    );
  });

  it('keeps every name within the macOS socket path budget', () => {
    const longId = `${'p'.repeat(64)}:${'t'.repeat(64)}:${'c'.repeat(64)}`;
    const name = makeZellijSessionName(longId, 'A very long task name that keeps going and going');

    expect(name.length).toBeLessThanOrEqual(ZELLIJ_SESSION_NAME_MAX_LENGTH);
    // Default macOS TMPDIR (49) + zellij-<uid>/ (12) + contract_version_1/ (19) + name.
    expect(49 + 12 + 19 + name.length).toBeLessThanOrEqual(103);
  });

  it('sanitizes labels and falls back when empty', () => {
    expect(makeZellijSessionLabel('  Hello, World! 42 ')).toBe('hello-worl');
    expect(makeZellijSessionLabel('Fix login')).toBe('fix-login');
    expect(makeZellijSessionLabel('---')).toBe('session');
    expect(makeZellijSessionLabel(undefined)).toBe('session');
    expect(makeZellijSessionLabel('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghij');
    expect(makeZellijSessionLabel('abcdefghi-tail')).toBe('abcdefghi');
  });
});

describe('parseZellijSessionName', () => {
  it('round-trips generated names', () => {
    const name = makeZellijSessionName(SESSION_ID, 'My Task');

    expect(parseZellijSessionName(name)).toEqual({
      label: 'my-task',
      sessionHash: zellijSessionHash(SESSION_ID),
    });
  });

  it('returns null for names that are not Emdash zellij sessions', () => {
    expect(parseZellijSessionName('scratch')).toBeNull();
    expect(parseZellijSessionName('emdash-label.abcdefgh')).toBeNull();
    expect(parseZellijSessionName('em-')).toBeNull();
    expect(parseZellijSessionName('em-nohash')).toBeNull();
    expect(parseZellijSessionName('em-label.short')).toBeNull();
    expect(parseZellijSessionName('em-Bad Label.abcdefgh')).toBeNull();
    expect(parseZellijSessionName('em-label.abcdefg/')).toBeNull();
  });

  it('matches sessions back to their PTY session id', () => {
    const name = makeZellijSessionName(SESSION_ID, 'label-the-caller-forgot');

    expect(isZellijSessionForPtySessionId(name, SESSION_ID)).toBe(true);
    expect(isZellijSessionForPtySessionId(name, 'project-1:task-1:other')).toBe(false);
    expect(isZellijSessionForPtySessionId('em-other', SESSION_ID)).toBe(false);
  });
});

describe('buildZellijShellLine', () => {
  const sessionName = makeZellijSessionName(SESSION_ID, 'My Task');

  it('creates a POSIX wrapper that creates fresh sessions in the foreground', () => {
    const line = buildZellijShellLine(sessionName, 'codex --resume abc', '/work/tree');

    expect(line.startsWith('/bin/sh -c ')).toBe(true);
    expect(line).toContain('command -v zellij');
    expect(line).toContain('exit 127');
    expect(line).toContain(sessionName);
    expect(line).toContain(
      'zellij attach --create "$session" options --default-layout "$layout_file" --scroll-buffer-size 100000 --on-force-close detach'
    );
    expect(line).toContain('zellij delete-session "$remnant"');
    expect(line).toContain('zellij attach "$1" options --on-force-close detach');
    expect(line).toContain('index($0, "(EXITED") == 0');
    expect(line).not.toContain('--create-background');
    expect(line).not.toContain('<<');
  });

  it('matches live sessions by the id hash so a renamed task still attaches', () => {
    const script = buildZellijAttachScript(sessionName, 'codex', '/work/tree');

    expect(script).toContain(`session_hash=${zellijSessionHash(SESSION_ID)}`);
    expect(script).toContain('$1 ~ ("^em-[a-z0-9-]+[.]" hash "$")');
    expect(script).toContain('existing=$(active_session_named)');
    expect(script).toContain('delete_remnants');
  });

  it('emits a single-line script /bin/sh can parse', async () => {
    const script = buildZellijAttachScript(sessionName, `echo "it's" && codex`, "/work/it's here", {
      shell: '/bin/zsh',
    });

    expect(script).not.toContain('\n');
    await expect(promisify(execFile)('sh', ['-n', '-c', script])).resolves.toBeDefined();
  });

  it('emits a line csh can parse when it is the outer shell', async () => {
    const line = buildZellijShellLine(sessionName, `echo "it's" && codex`, "/work/it's here", {
      shell: '/bin/tcsh',
      shellArgs: ['-c'],
      outerShellFamily: 'csh',
    });

    expect(line).not.toContain('\n');
    expect(line).toContain('\\!');
    const tcsh = ['/bin/tcsh', '/usr/bin/tcsh', '/bin/csh'].find((path) => existsSync(path));
    if (!tcsh) return;
    await expect(promisify(execFile)(tcsh, ['-n', '-c', line])).resolves.toBeDefined();
  });

  it('aborts instead of resurrecting a stale remnant that could not be deleted', () => {
    const script = buildZellijAttachScript(sessionName, 'codex', '/work/tree');

    expect(script).toContain('stale_named_remnant_exists');
    expect(script).toContain('could not delete the stale zellij session');
  });

  it('writes control characters as braced KDL escapes and keeps literal backslash text', () => {
    const control = buildZellijAttachScript(sessionName, 'printf "\u001b[0m"', '/work/tree');
    expect(control).toContain('\\u{1b}');

    // A prompt that literally contains the four characters \u001b must arrive
    // unchanged: KDL decodes \\ to one backslash, so the layout carries \\u001b.
    const literal = buildZellijAttachScript(sessionName, 'echo \\u001b', '/work/tree');
    expect(literal).toContain('echo \\\\u001b');
    expect(literal).not.toContain('\\u{');
  });

  it('quotes the other KDL escapes and leaves non-ASCII text alone', () => {
    const script = buildZellijAttachScript(sessionName, 'a\tb\rc\x7fd é 🚀', '/work/tree');

    expect(script).toContain('a\\tb\\rc\\u{7f}d é 🚀');
  });

  it('validates the layout cleanup delay before handing it to sleep', () => {
    const script = buildZellijAttachScript(sessionName, 'codex', '/work/tree');

    expect(script).toContain('case "$delay" in \'\' | *[!0-9]*) delay=30 ;; esac');
  });

  it('writes a single-tab layout that runs the command through the default shell', () => {
    const line = buildZellijShellLine(sessionName, 'codex --resume abc', '/work/tree');

    expect(line).toContain('tab name="my-task"');
    expect(line).toContain(
      'pane command="/bin/sh" cwd="/work/tree" close_on_exit=true focus=true name="my-task"'
    );
    expect(line).toContain('args "-c" "codex --resume abc"');
  });

  it('runs panes directly through the selected shell profile', () => {
    const line = buildZellijShellLine(sessionName, 'exec /bin/zsh -il', '/work/tree', {
      shell: '/bin/zsh',
      shellArgs: ['-lc'],
    });

    expect(line).toContain('pane command="/bin/zsh"');
    expect(line).toContain('args "-lc" "exec /bin/zsh -il"');
  });

  it('escapes quotes in the command line and paths', () => {
    const line = buildZellijShellLine(sessionName, `echo "it's"`, "/work/it's here");

    // The layout is single-quoted once for its `layout=` assignment and the
    // whole script is single-quoted again for `/bin/sh -c`, so apostrophes
    // inside the KDL arrive doubly escaped.
    const posixQuoted = (value: string) => value.replaceAll("'", "'\\''");
    const embedded = (value: string) => posixQuoted(posixQuoted(value));
    expect(line).toContain(embedded(`args "-c" ${JSON.stringify(`echo "it's"`)}`));
    expect(line).toContain(embedded(`cwd=${JSON.stringify("/work/it's here")}`));
  });
});

describe('parseZellijSessionList', () => {
  it('separates active sessions from exited resurrectable ones and ignores other names', () => {
    const parsed = parseZellijSessionList(
      [
        'em-my-task.abcdefgh [Created 2h 3m ago]',
        'em-other.klmnopqr [Created 5s ago] (EXITED - attach to resurrect)',
        'scratch [Created 1m ago]',
        '',
        'No active zellij sessions found.',
      ].join('\n')
    );

    expect(parsed).toEqual(
      new Map([
        ['em-my-task.abcdefgh', { active: true }],
        ['em-other.klmnopqr', { active: false }],
      ])
    );
  });
});

describe('listZellijSessions', () => {
  it('runs one zellij list-sessions command', async () => {
    const exec = vi.fn(async () => ({
      stdout: 'em-my-task.abcdefgh [Created 2h 3m ago]\n',
      stderr: '',
    }));

    const sessions = await listZellijSessions(stubExecContext(exec));

    expect(exec).toHaveBeenCalledWith('zellij', ['list-sessions', '--no-formatting'], {
      timeout: 10_000,
    });
    expect(sessions).toEqual(new Map([['em-my-task.abcdefgh', { active: true }]]));
  });

  it('returns an empty map when zellij reports no sessions', async () => {
    const exec = vi.fn(async () => {
      throw { exitCode: 1, stderr: 'No active zellij sessions found.' };
    });

    await expect(listZellijSessions(stubExecContext(exec))).resolves.toEqual(new Map());
  });

  it('returns an empty map when zellij is not installed', async () => {
    const boundExecShape = vi.fn(async () => {
      throw { exitCode: null, stderr: 'spawn zellij ENOENT' };
    });
    await expect(listZellijSessions(stubExecContext(boundExecShape))).resolves.toEqual(new Map());
    const spawnFailure = vi.fn(async () => {
      throw Object.assign(new Error('spawn zellij ENOENT'), { code: 'ENOENT', stderr: '' });
    });
    const shellNotFound = vi.fn(async () => {
      throw { exitCode: 127, stderr: 'sh: zellij: command not found' };
    });

    await expect(listZellijSessions(stubExecContext(spawnFailure))).resolves.toEqual(new Map());
    await expect(listZellijSessions(stubExecContext(shellNotFound))).resolves.toEqual(new Map());
  });

  it('rethrows unexpected failures', async () => {
    const exec = vi.fn(async () => {
      throw { exitCode: 2, stderr: 'permission denied' };
    });

    await expect(listZellijSessions(stubExecContext(exec))).rejects.toEqual({
      exitCode: 2,
      stderr: 'permission denied',
    });
  });
});

describe('killZellijSession', () => {
  it('force-deletes the session and treats "not found" as success', async () => {
    const exec = vi.fn(async () => {
      throw { exitCode: 2, stderr: 'Session "em-my-task.abcdefgh" not found' };
    });
    const onError = vi.fn();

    await killZellijSession(stubExecContext(exec), 'em-my-task.abcdefgh', onError);

    expect(exec).toHaveBeenCalledWith('zellij', [
      'delete-session',
      '--force',
      'em-my-task.abcdefgh',
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports other failures through onError', async () => {
    const exec = vi.fn(async () => {
      throw { exitCode: 2, stderr: 'permission denied' };
    });
    const onError = vi.fn();

    await killZellijSession(stubExecContext(exec), 'em-my-task.abcdefgh', onError);

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('activeZellijSessionFor', () => {
  it('finds a running session for the same PTY session under any label', () => {
    const requested = makeZellijSessionName(SESSION_ID, 'new-name');
    const created = makeZellijSessionName(SESSION_ID, 'old-name');
    const sessions = new Map([
      [created, { active: true }],
      [makeZellijSessionName('project-1:task-1:other', 'new-name'), { active: true }],
    ]);

    expect(activeZellijSessionFor(sessions, requested)).toBe(created);
    expect(
      activeZellijSessionFor(new Map([[created, { active: false }]]), requested)
    ).toBeUndefined();
    expect(activeZellijSessionFor(sessions, 'not-an-emdash-name')).toBeUndefined();
  });
});

describe('killZellijSessionsMatching', () => {
  it('deletes running and exited sessions that share the id hash, under any label', async () => {
    const requested = makeZellijSessionName(SESSION_ID, 'new-name');
    const stale = makeZellijSessionName(SESSION_ID, 'old-name');
    const other = makeZellijSessionName('project-1:task-1:other', 'other');
    const exec = vi.fn(async (_command: string, args: string[]) =>
      args[0] === 'list-sessions'
        ? {
            stdout: `${stale} [Created 1m ago] (EXITED - attach to resurrect)\n${requested} [Created 1m ago]\n${other} [Created 1m ago]\n`,
            stderr: '',
          }
        : { stdout: '', stderr: '' }
    );

    await killZellijSessionsMatching(stubExecContext(exec), requested);

    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenCalledWith('zellij', ['delete-session', '--force', stale]);
    expect(exec).toHaveBeenCalledWith('zellij', ['delete-session', '--force', requested]);
    expect(exec).not.toHaveBeenCalledWith('zellij', ['delete-session', '--force', other]);
  });

  it('reports a listing failure through onError instead of throwing', async () => {
    const exec = vi.fn(async () => {
      throw { exitCode: 2, stderr: 'permission denied' };
    });
    const onError = vi.fn();

    await killZellijSessionsMatching(
      stubExecContext(exec),
      makeZellijSessionName(SESSION_ID, 'x'),
      onError
    );
    await killZellijSessionsForPtySessionIds(stubExecContext(exec), [SESSION_ID], onError);

    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe('killZellijSessionsForPtySessionIds', () => {
  it('kills every Emdash zellij session whose hash matches one of the ids', async () => {
    const wanted = makeZellijSessionName(SESSION_ID, 'wanted');
    const other = makeZellijSessionName('project-1:task-1:other', 'other');
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === 'list-sessions') {
        return {
          stdout: `${wanted} [Created 1m ago]\n${other} [Created 1m ago] (EXITED)\nscratch [Created 1m ago]\n`,
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    await killZellijSessionsForPtySessionIds(stubExecContext(exec), [SESSION_ID]);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenLastCalledWith('zellij', ['delete-session', '--force', wanted]);
  });

  it('does nothing without ids', async () => {
    const exec = vi.fn();

    await killZellijSessionsForPtySessionIds(stubExecContext(exec), []);

    expect(exec).not.toHaveBeenCalled();
  });
});

function stubExecContext(exec: (...args: never[]) => Promise<unknown>): IExecutionContext {
  return { supportsLocalSpawn: true, exec } as unknown as IExecutionContext;
}
