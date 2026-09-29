import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '#primitives/exec/api';
import {
  buildZellijAttachScript,
  buildZellijShellLine,
  killZellijSession,
  listZellijSessions,
  parseZellijSessionInventory,
} from './zellij-commands';
import { makeZellijSessionName } from './zellij-identity';

const IDENTITY = 'project-1:task-1:conversation-1';
const sessionName = makeZellijSessionName(IDENTITY, 'My Task');

function stubExecContext(exec: IExecutionContext['exec']): IExecutionContext {
  return {
    root: undefined,
    supportsLocalSpawn: false,
    exec,
    async execStreaming() {
      return { exitCode: 0 };
    },
    dispose() {},
  };
}

describe('buildZellijShellLine', () => {
  it('creates fresh sessions in the foreground and attaches to running ones', () => {
    const line = buildZellijShellLine(sessionName, 'codex --resume abc', '/work/tree');

    expect(line.startsWith('/bin/sh -c ')).toBe(true);
    expect(line).toContain('command -v zellij');
    expect(line).toContain('exit 127');
    expect(line).toContain(sessionName);
    expect(line).toContain(
      'zellij attach --create "$session" options --default-layout "$layout_file" --scroll-buffer-size 100000 --on-force-close detach'
    );
    expect(line).toContain('zellij attach "$session" options --on-force-close detach');
    expect(line).toContain('zellij delete-session "$session"');
    expect(line).not.toContain('--create-background');
    expect(line).not.toContain('<<');
  });

  it('matches the session by its exact name', () => {
    const script = buildZellijAttachScript(sessionName, 'codex', '/work/tree');

    expect(script).toContain('$1 == session');
    expect(script).toContain('index($0, "(EXITED") > 0 ? "exited" : "active"');
  });

  it('emits a single-line script /bin/sh can parse', async () => {
    const script = buildZellijAttachScript(sessionName, `echo "it's" && codex`, "/work/it's here", {
      shell: '/bin/zsh',
    });

    expect(script).not.toContain('\n');
    await expect(promisify(execFile)('sh', ['-n', '-c', script])).resolves.toBeDefined();
  });

  it('escapes history expansion when csh is the outer shell', () => {
    const line = buildZellijShellLine(sessionName, `echo "it's" && codex`, "/work/it's here", {
      shell: '/bin/tcsh',
      shellArgs: ['-c'],
      outerShellFamily: 'csh',
    });

    expect(line).not.toContain('\n');
    expect(line).toContain('\\!');
  });

  const tcsh = ['/bin/tcsh', '/usr/bin/tcsh', '/bin/csh'].find((path) => existsSync(path));
  it.skipIf(!tcsh)('emits a line a real csh can parse', async () => {
    const line = buildZellijShellLine(sessionName, `echo "it's" && codex`, "/work/it's here", {
      shell: '/bin/tcsh',
      shellArgs: ['-c'],
      outerShellFamily: 'csh',
    });

    await expect(promisify(execFile)(tcsh!, ['-n', '-c', line])).resolves.toBeDefined();
  });

  it('aborts instead of resurrecting a stale remnant that could not be deleted', () => {
    const script = buildZellijAttachScript(sessionName, 'codex', '/work/tree');

    expect(script).toContain('could not delete the stale zellij session');
  });

  it('writes control characters as braced KDL escapes and keeps literal backslash text', () => {
    const control = buildZellijAttachScript(sessionName, 'printf "\u001b[0m"', '/work/tree');
    expect(control).toContain('\\u{1b}');

    // A prompt that literally contains the six characters \u001b must arrive
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
    const script = buildZellijAttachScript(sessionName, 'codex --resume abc', '/work/tree');

    expect(script).toContain('tab name="my-task"');
    expect(script).toContain(
      'pane command="/bin/sh" cwd="/work/tree" close_on_exit=true focus=true name="my-task"'
    );
    expect(script).toContain('args "-c" "codex --resume abc"');
  });

  it('runs panes directly through the selected shell profile', () => {
    const script = buildZellijAttachScript(sessionName, 'exec /bin/zsh -il', '/work/tree', {
      shell: '/bin/zsh',
      shellArgs: ['-lc'],
    });

    expect(script).toContain('pane command="/bin/zsh"');
    expect(script).toContain('args "-lc" "exec /bin/zsh -il"');
  });

  it('escapes quotes in the command line and paths', () => {
    const script = buildZellijAttachScript(sessionName, `echo "it's"`, "/work/it's here");

    // Each layout line is single-quoted once as a printf argument.
    const posixQuoted = (value: string) => value.replaceAll("'", "'\\''");
    expect(script).toContain(posixQuoted(`args "-c" "echo \\"it's\\""`));
    expect(script).toContain(posixQuoted(`cwd="/work/it's here"`));
  });
});

describe('parseZellijSessionInventory', () => {
  it('separates running sessions from exited resurrectable ones', () => {
    expect(
      parseZellijSessionInventory(
        [
          'my-task-0123456789 [Created 2h 3m ago]',
          'other-abcdef0123 [Created 5s ago] (EXITED - attach to resurrect)',
          'scratch [Created 1m ago]',
          '',
          'No active zellij sessions found.',
        ].join('\n')
      )
    ).toEqual([
      { name: 'my-task-0123456789', active: true },
      { name: 'other-abcdef0123', active: false },
      { name: 'scratch', active: true },
    ]);
  });
});

describe('listZellijSessions', () => {
  it('runs one bounded zellij list-sessions command', async () => {
    const exec = vi.fn(async () => ({
      stdout: 'my-task-0123456789 [Created 2h 3m ago]\n',
      stderr: '',
    }));

    const sessions = await listZellijSessions(stubExecContext(exec));

    expect(exec).toHaveBeenCalledWith('zellij', ['list-sessions', '--no-formatting'], {
      timeout: 10_000,
    });
    expect(sessions).toEqual([{ name: 'my-task-0123456789', active: true }]);
  });

  it('returns nothing when zellij reports no sessions', async () => {
    const exec = vi.fn(async () => {
      throw { exitCode: 1, stderr: 'No active zellij sessions found.' };
    });

    await expect(listZellijSessions(stubExecContext(exec))).resolves.toEqual([]);
  });

  it('returns nothing when zellij is not installed', async () => {
    const boundExecShape = vi.fn(async () => {
      throw Object.assign(new Error('Failed to start process'), {
        exitCode: null,
        stderr: '',
        cause: Object.assign(new Error('spawn zellij ENOENT'), { code: 'ENOENT' }),
      });
    });
    const spawnFailure = vi.fn(async () => {
      throw Object.assign(new Error('spawn zellij ENOENT'), { code: 'ENOENT', stderr: '' });
    });
    const shellNotFound = vi.fn(async () => {
      throw { exitCode: 127, stderr: 'sh: zellij: command not found' };
    });

    await expect(listZellijSessions(stubExecContext(boundExecShape))).resolves.toEqual([]);
    await expect(listZellijSessions(stubExecContext(spawnFailure))).resolves.toEqual([]);
    await expect(listZellijSessions(stubExecContext(shellNotFound))).resolves.toEqual([]);
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
      throw { exitCode: 2, stderr: 'Session "my-task-0123456789" not found' };
    });
    const onError = vi.fn();

    await killZellijSession(stubExecContext(exec), 'my-task-0123456789', onError);

    expect(exec).toHaveBeenCalledWith('zellij', [
      'delete-session',
      '--force',
      'my-task-0123456789',
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports other failures through onError', async () => {
    const exec = vi.fn(async () => {
      throw { exitCode: 2, stderr: 'permission denied' };
    });
    const onError = vi.fn();

    await killZellijSession(stubExecContext(exec), 'my-task-0123456789', onError);

    expect(onError).toHaveBeenCalledTimes(1);
  });
});
