import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '#primitives/exec/api';
import {
  buildZellijShellLine,
  isZellijSessionForPtySessionId,
  killZellijSession,
  killZellijSessionsForPtySessionIds,
  listZellijSessions,
  makeZellijSessionLabel,
  makeZellijSessionName,
  parseZellijSessionList,
  parseZellijSessionName,
  zellijSessionHash,
} from './zellij';

const SESSION_ID = 'project-1:task-1:conversation-1';

describe('makeZellijSessionName', () => {
  it('combines a readable label with a short deterministic session hash', () => {
    const name = makeZellijSessionName(SESSION_ID, 'Fix login bug');

    expect(name).toBe(`emdash-fix-login-bug.${zellijSessionHash(SESSION_ID)}`);
    expect(name).toMatch(/^emdash-[a-z0-9-]+\.[A-Za-z0-9_-]{10}$/);
    expect(makeZellijSessionName(SESSION_ID, 'Fix login bug')).toBe(name);
    expect(makeZellijSessionName('project-1:task-1:conversation-2', 'Fix login bug')).not.toBe(
      name
    );
  });

  it('keeps long real-world ids short enough for zellij socket paths', () => {
    const longId = `${'p'.repeat(64)}:${'t'.repeat(64)}:${'c'.repeat(64)}`;
    const name = makeZellijSessionName(longId, 'A very long task name that keeps going and going');

    expect(name.length).toBeLessThanOrEqual('emdash-'.length + 20 + 1 + 10);
  });

  it('sanitizes labels and falls back when empty', () => {
    expect(makeZellijSessionLabel('  Hello, World! 42 ')).toBe('hello-world-42');
    expect(makeZellijSessionLabel('---')).toBe('session');
    expect(makeZellijSessionLabel(undefined)).toBe('session');
    expect(makeZellijSessionLabel('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijklmnopqrst');
    expect(makeZellijSessionLabel('abcdefghijklmnopqrs-tail')).toBe('abcdefghijklmnopqrs');
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
    expect(parseZellijSessionName('emdash-')).toBeNull();
    expect(parseZellijSessionName('emdash-nohash')).toBeNull();
    expect(parseZellijSessionName('emdash-label.short')).toBeNull();
    expect(parseZellijSessionName('emdash-Bad Label.abcdefghij')).toBeNull();
    expect(parseZellijSessionName('emdash-label.abcdefghi/')).toBeNull();
  });

  it('matches sessions back to their PTY session id', () => {
    const name = makeZellijSessionName(SESSION_ID, 'label-the-caller-forgot');

    expect(isZellijSessionForPtySessionId(name, SESSION_ID)).toBe(true);
    expect(isZellijSessionForPtySessionId(name, 'project-1:task-1:other')).toBe(false);
    expect(isZellijSessionForPtySessionId('emdash-other', SESSION_ID)).toBe(false);
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
      'zellij attach --create "$session" options --default-layout "$layout_file" --on-force-close detach'
    );
    expect(line).toContain('zellij delete-session "$session"');
    expect(line).toContain('zellij attach "$session" options --on-force-close detach');
    expect(line).toContain('index($0, "(EXITED") == 0');
    expect(line).not.toContain('--create-background');
    expect(line).not.toContain('<<');
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
        'emdash-my-task.abcdefghij [Created 2h 3m ago]',
        'emdash-other.klmnopqrst [Created 5s ago] (EXITED - attach to resurrect)',
        'scratch [Created 1m ago]',
        '',
        'No active zellij sessions found.',
      ].join('\n')
    );

    expect(parsed).toEqual(
      new Map([
        ['emdash-my-task.abcdefghij', { active: true }],
        ['emdash-other.klmnopqrst', { active: false }],
      ])
    );
  });
});

describe('listZellijSessions', () => {
  it('runs one zellij list-sessions command', async () => {
    const exec = vi.fn(async () => ({
      stdout: 'emdash-my-task.abcdefghij [Created 2h 3m ago]\n',
      stderr: '',
    }));

    const sessions = await listZellijSessions(stubExecContext(exec));

    expect(exec).toHaveBeenCalledWith('zellij', ['list-sessions', '--no-formatting']);
    expect(sessions).toEqual(new Map([['emdash-my-task.abcdefghij', { active: true }]]));
  });

  it('returns an empty map when zellij reports no sessions', async () => {
    const exec = vi.fn(async () => {
      throw { exitCode: 1, stderr: 'No active zellij sessions found.' };
    });

    await expect(listZellijSessions(stubExecContext(exec))).resolves.toEqual(new Map());
  });

  it('returns an empty map when zellij is not installed', async () => {
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
  it('force-deletes the session and reports failures through onError', async () => {
    const exec = vi.fn(async () => {
      throw { exitCode: 1, stderr: 'Session not found' };
    });
    const onError = vi.fn();

    await killZellijSession(stubExecContext(exec), 'emdash-my-task.abcdefghij', onError);

    expect(exec).toHaveBeenCalledWith('zellij', [
      'delete-session',
      '--force',
      'emdash-my-task.abcdefghij',
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
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
