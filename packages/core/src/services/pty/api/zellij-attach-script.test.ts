import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildZellijShellLine } from './zellij-commands';
import { makeZellijSessionName } from './zellij-identity';

/**
 * Runs the generated attach line through a real `/bin/sh` against a stub
 * `zellij` on PATH, so the script's control flow is exercised rather than
 * its text. The stub records every call and serves `list-sessions` from a
 * state file the test controls.
 */
const SESSION = makeZellijSessionName('project-1:task-1:conversation-1', 'My Task');
const COMMAND = `printf '%s\\n' "it's"`;
const CWD = "/work/it's here";

const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_DIR/calls"
case "$1" in
  list-sessions)
    [ -f "$STUB_DIR/sessions" ] && cat "$STUB_DIR/sessions"
    exit 0
    ;;
  delete-session)
    if [ -f "$STUB_DIR/delete-fails" ]; then exit 1; fi
    : > "$STUB_DIR/sessions"
    exit 0
    ;;
  attach)
    if [ "$2" = "--create" ]; then
      cp "$6" "$STUB_DIR/layout.kdl"
      if [ -f "$STUB_DIR/create-fails" ]; then
        if [ -f "$STUB_DIR/create-races" ]; then printf '%s [Created 0s ago]\\n' "$3" > "$STUB_DIR/sessions"; fi
        exit 3
      fi
    fi
    exit 0
    ;;
esac
exit 0
`;

type Run = { code: number; stderr: string; calls: string[] };

describe.skipIf(process.platform === 'win32')('zellij attach script control flow', () => {
  let dir: string;
  let stubDir: string;
  let tmpDir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emdash-zellij-script-'));
    stubDir = path.join(dir, 'stub');
    tmpDir = path.join(dir, 'tmp');
    await fs.mkdir(path.join(dir, 'bin'));
    await fs.mkdir(stubDir);
    await fs.mkdir(tmpDir);
    await fs.writeFile(path.join(dir, 'bin', 'zellij'), STUB, { mode: 0o755 });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function run(options: { withZellij?: boolean } = {}): Promise<Run> {
    const line = buildZellijShellLine(SESSION, COMMAND, CWD, {
      shell: '/bin/bash',
      shellArgs: ['-c'],
    });
    const searchPath =
      options.withZellij === false
        ? path.join(dir, 'empty')
        : `${path.join(dir, 'bin')}:/usr/bin:/bin`;
    return new Promise((resolve) => {
      execFile(
        '/bin/sh',
        ['-c', line],
        {
          env: {
            PATH: searchPath,
            STUB_DIR: stubDir,
            TMPDIR: tmpDir,
            EMDASH_ZELLIJ_LAYOUT_CLEANUP_DELAY_SECONDS: '0',
          },
        },
        async (error, _stdout, stderr) => {
          const calls = await fs.readFile(path.join(stubDir, 'calls'), 'utf8').catch(() => '');
          resolve({
            code: error ? Number(error.code ?? 1) : 0,
            stderr,
            calls: calls.split('\n').filter(Boolean),
          });
        }
      );
    });
  }

  const listed = (state: string) => fs.writeFile(path.join(stubDir, 'sessions'), `${state}\n`);
  const flag = (name: string) => fs.writeFile(path.join(stubDir, name), '');
  const createCall = expect.stringMatching(
    new RegExp(
      `^attach --create ${SESSION} options --default-layout \\S+/layout\\.kdl --scroll-buffer-size 100000 --on-force-close detach$`
    )
  );
  const attachCall = `attach ${SESSION} options --on-force-close detach`;

  it('creates the session from a layout that carries the command verbatim', async () => {
    const result = await run();

    expect(result.code).toBe(0);
    expect(result.calls).toContainEqual(createCall);
    expect(result.calls).not.toContain(attachCall);
    const layout = await fs.readFile(path.join(stubDir, 'layout.kdl'), 'utf8');
    expect(layout).toContain('tab name="my-task"');
    expect(layout).toContain(`pane command="/bin/bash" cwd="/work/it's here"`);
    expect(layout).toContain(`args "-c" "printf '%s\\\\n' \\"it's\\""`);
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it('attaches to a running session without writing a layout', async () => {
    await listed(`${SESSION} [Created 1m ago]`);

    const result = await run();

    expect(result.code).toBe(0);
    expect(result.calls).toContain(attachCall);
    expect(result.calls).not.toContainEqual(createCall);
    await expect(fs.stat(path.join(stubDir, 'layout.kdl'))).rejects.toThrow();
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it('ignores sessions whose name only starts with the session name', async () => {
    await listed(`${SESSION}-copy [Created 1m ago]`);

    const result = await run();

    expect(result.calls).toContainEqual(createCall);
    expect(result.calls).not.toContain(attachCall);
  });

  it('deletes an exited remnant before creating a fresh session', async () => {
    await listed(`${SESSION} [Created 2h ago] (EXITED - attach to resurrect)`);

    const result = await run();

    expect(result.code).toBe(0);
    const deleted = result.calls.indexOf(`delete-session ${SESSION}`);
    const created = result.calls.findIndex((call) => call.startsWith('attach --create'));
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(created).toBeGreaterThan(deleted);
  });

  it('aborts instead of resurrecting a remnant that could not be deleted', async () => {
    await listed(`${SESSION} [Created 2h ago] (EXITED - attach to resurrect)`);
    await flag('delete-fails');

    const result = await run();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`could not delete the stale zellij session ${SESSION}`);
    expect(result.calls.some((call) => call.startsWith('attach'))).toBe(false);
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it('attaches when another client created the session first', async () => {
    await flag('create-fails');
    await flag('create-races');

    const result = await run();

    expect(result.code).toBe(0);
    expect(result.calls).toContainEqual(createCall);
    expect(result.calls.at(-1)).toBe(attachCall);
  });

  it('passes on the exit status of a failed create and removes the layout', async () => {
    await flag('create-fails');

    const result = await run();

    expect(result.code).toBe(3);
    expect(result.calls).not.toContain(attachCall);
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it('exits 127 with a clear message when zellij is not installed', async () => {
    const result = await run({ withZellij: false });

    expect(result.code).toBe(127);
    expect(result.stderr).toContain('zellij is not installed or not on PATH');
    expect(result.calls).toEqual([]);
  });
});
