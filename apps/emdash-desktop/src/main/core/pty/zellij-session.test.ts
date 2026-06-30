import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import {
  buildZellijShellLine,
  killZellijSessionsForPtySessionId,
  makeZellijSessionLabel,
  makeZellijSessionName,
  parseZellijSessionName,
  zellijLeafHash,
  zellijProjectHash,
  zellijSessionHash,
} from './zellij-session';

type ExecCall = { command: string; args: string[] };

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, { mode: 0o755 });
}

function makeCtx(stdout: string): { ctx: IExecutionContext; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const ctx = {
    root: undefined,
    supportsLocalSpawn: false,
    exec: vi.fn(async (command: string, args: string[] = []) => {
      calls.push({ command, args });
      return {
        stdout: command === 'zellij' && args[0] === 'list-sessions' ? stdout : '',
        stderr: '',
      };
    }),
    execStreaming: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IExecutionContext;
  return { ctx, calls };
}

describe('makeZellijSessionName', () => {
  it('stores short deterministic project, leaf and session hashes with a readable label', () => {
    const sessionId = makePtySessionId('proj-1', 'task-2', 'conv-3');
    const name = makeZellijSessionName(sessionId, 'Claude Chat / Main');
    const parts = parseZellijSessionName(name);

    expect(name).toMatch(/^emdash-[^.]+\.pty\.[^.]+\.[^.]+\.claude-chat-main$/);
    expect(name.length).toBeLessThanOrEqual(65);
    expect(parts).toEqual({
      projectHash: zellijProjectHash('proj-1'),
      leafKind: 'pty',
      leafHash: zellijLeafHash('conv-3'),
      sessionHash: zellijSessionHash(sessionId),
    });
  });

  it('keeps long real-world ids below zellij socket path limits', () => {
    const sessionId = makePtySessionId(
      `project-${'x'.repeat(80)}`,
      `task-${'y'.repeat(80)}`,
      `conversation-${'z'.repeat(80)}`
    );

    expect(
      makeZellijSessionName(sessionId, 'Very Long Conversation Name').length
    ).toBeLessThanOrEqual(65);
  });

  it('sanitizes labels and falls back when empty', () => {
    expect(makeZellijSessionLabel(' Dev Server! ')).toBe('dev-server');
    expect(makeZellijSessionLabel('---')).toBe('session');
  });

  it('returns null for names that are not valid emdash zellij sessions', () => {
    expect(parseZellijSessionName('other-session')).toBeNull();
    expect(parseZellijSessionName('emdash-')).toBeNull();
    expect(parseZellijSessionName('emdash-label.not*base64url')).toBeNull();
    expect(parseZellijSessionName('emdash-too-short.pty.leaf.session.label')).toBeNull();
    expect(parseZellijSessionName('emdash-abc*1234.pty.abcdefghij.abcdefgh.label')).toBeNull();
  });
});

describe('buildZellijShellLine', () => {
  it('creates a POSIX wrapper that creates fresh sessions in the foreground', () => {
    const result = buildZellijShellLine(
      'emdash-claude.abc123',
      "printf 'hello world'",
      '/workspace/project',
      { displayName: 'Claude Chat' }
    );

    expect(result).toMatch(/^\/bin\/sh -c /);
    expect(result).toContain('command -v zellij');
    expect(result).toContain('zellij list-sessions --no-formatting');
    expect(result).toContain('zellij attach --create "$session"');
    expect(result).toContain('zellij attach "$session" options --on-force-close detach');
    expect(result).not.toContain('--create-background');
    expect(result).toContain('tab name="Claude Chat"');
    expect(result).toContain('pane command="/bin/sh"');
    expect(result).toContain('args "-c" "printf');
    expect(result).toContain('cwd="/workspace/project"');
    expect(result).toContain('printf');
    expect(result).toContain('hello world');
  });

  it('runs panes directly through the selected shell profile', () => {
    const result = buildZellijShellLine(
      'emdash-claude.abc123',
      'source ~/.nvm/nvm.sh && exec bash -il',
      '/workspace/project',
      {
        displayName: 'Claude Chat',
        shell: '/bin/bash',
        shellArgs: ['-lc'],
      }
    );

    expect(result).toContain('pane command="/bin/bash"');
    expect(result).toContain('args "-lc" "source ~/.nvm/nvm.sh && exec bash -il"');
    expect(result).toContain('source ~/.nvm/nvm.sh && exec bash -il');
    expect(result).not.toContain("exec '/bin/bash'");
  });

  it('attaches active sessions without deleting or recreating them', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'emdash-zellij-fake-'));
    const callsFile = path.join(root, 'calls.txt');
    const sessionName = 'emdash-fake.pty.leafhash00.session1.label';
    try {
      writeFileSync(callsFile, '');
      writeExecutable(
        path.join(root, 'zellij'),
        [
          '#!/bin/sh',
          'if [ "$1" = "list-sessions" ]; then',
          `  printf '%s [Created today]\\n' ${JSON.stringify(sessionName)}`,
          '  exit 0',
          'fi',
          'if [ "$1" = "delete-session" ]; then',
          `  printf 'delete %s\\n' "$2" >> ${JSON.stringify(callsFile)}`,
          '  exit 0',
          'fi',
          'if [ "$1" = "attach" ]; then',
          '  case " $* " in',
          `    *" --create "*) printf 'create %s\\n' "$3" >> ${JSON.stringify(callsFile)}; exit 0 ;;`,
          `    *) printf 'attach %s\\n' "$2" >> ${JSON.stringify(callsFile)}; exit 0 ;;`,
          '  esac',
          'fi',
          'exit 1',
          '',
        ].join('\n')
      );

      const result = spawnSync(
        '/bin/sh',
        ['-lc', buildZellijShellLine(sessionName, 'true', root)],
        {
          env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        }
      );

      expect(result.status).toBe(0);
      expect(readFileSync(callsFile, 'utf8').trim()).toBe(`attach ${sessionName}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('propagates foreground create failures when the session was not created', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'emdash-zellij-fake-'));
    const callsFile = path.join(root, 'calls.txt');
    try {
      writeFileSync(callsFile, '');
      writeExecutable(
        path.join(root, 'zellij'),
        [
          '#!/bin/sh',
          `printf '%s\\n' "$*" >> ${JSON.stringify(callsFile)}`,
          'if [ "$1" = "list-sessions" ]; then exit 0; fi',
          'if [ "$1" = "delete-session" ]; then exit 0; fi',
          'if [ "$1" = "attach" ]; then exit 42; fi',
          'exit 0',
          '',
        ].join('\n')
      );

      const result = spawnSync(
        '/bin/sh',
        ['-lc', buildZellijShellLine('emdash-fake.pty.leaf.session.label', 'true', root)],
        {
          env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        }
      );

      const calls = readFileSync(callsFile, 'utf8').trim().split('\n');
      expect(result.status).toBe(42);
      expect(calls).toHaveLength(4);
      expect(calls[0]).toBe('list-sessions --no-formatting');
      expect(calls[1]).toBe('delete-session emdash-fake.pty.leaf.session.label');
      expect(calls[2]).toContain(
        'attach --create emdash-fake.pty.leaf.session.label options --default-layout '
      );
      expect(calls[2]).toContain(' --on-force-close detach');
      expect(calls[3]).toBe('list-sessions --no-formatting');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to attach when another process creates the session first', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'emdash-zellij-fake-'));
    const callsFile = path.join(root, 'calls.txt');
    const listCountFile = path.join(root, 'list-count.txt');
    const sessionName = 'emdash-fake.pty.leafhash00.session1.label';
    try {
      writeFileSync(callsFile, '');
      writeFileSync(listCountFile, '0');
      writeExecutable(
        path.join(root, 'zellij'),
        [
          '#!/bin/sh',
          'if [ "$1" = "list-sessions" ]; then',
          `  count=$(cat ${JSON.stringify(listCountFile)})`,
          '  count=$((count + 1))',
          `  printf '%s\\n' "$count" > ${JSON.stringify(listCountFile)}`,
          '  if [ "$count" -ge 2 ]; then',
          `    printf '%s [Created today]\\n' ${JSON.stringify(sessionName)}`,
          '  fi',
          '  exit 0',
          'fi',
          'if [ "$1" = "delete-session" ]; then',
          `  printf 'delete %s\\n' "$2" >> ${JSON.stringify(callsFile)}`,
          '  exit 0',
          'fi',
          'if [ "$1" = "attach" ]; then',
          '  case " $* " in',
          `    *" --create "*) printf 'create %s\\n' "$3" >> ${JSON.stringify(callsFile)}; exit 42 ;;`,
          `    *) printf 'attach %s\\n' "$2" >> ${JSON.stringify(callsFile)}; exit 0 ;;`,
          '  esac',
          'fi',
          'exit 1',
          '',
        ].join('\n')
      );

      const result = spawnSync(
        '/bin/sh',
        ['-lc', buildZellijShellLine(sessionName, 'true', root)],
        {
          env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        }
      );

      expect(result.status).toBe(0);
      expect(readFileSync(callsFile, 'utf8').trim().split('\n')).toEqual([
        `delete ${sessionName}`,
        `create ${sessionName}`,
        `attach ${sessionName}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recreates when an active session disappears before attach', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'emdash-zellij-fake-'));
    const callsFile = path.join(root, 'calls.txt');
    const listCountFile = path.join(root, 'list-count.txt');
    const sessionName = 'emdash-fake.pty.leafhash00.session1.label';
    try {
      writeFileSync(callsFile, '');
      writeFileSync(listCountFile, '0');
      writeExecutable(
        path.join(root, 'zellij'),
        [
          '#!/bin/sh',
          'if [ "$1" = "list-sessions" ]; then',
          `  count=$(cat ${JSON.stringify(listCountFile)})`,
          '  count=$((count + 1))',
          `  printf '%s\\n' "$count" > ${JSON.stringify(listCountFile)}`,
          '  if [ "$count" = "1" ]; then',
          `    printf '%s [Created today]\\n' ${JSON.stringify(sessionName)}`,
          '  fi',
          '  exit 0',
          'fi',
          'if [ "$1" = "delete-session" ]; then',
          `  printf 'delete %s\\n' "$2" >> ${JSON.stringify(callsFile)}`,
          '  exit 0',
          'fi',
          'if [ "$1" = "attach" ]; then',
          '  case " $* " in',
          `    *" --create "*) printf 'create %s\\n' "$3" >> ${JSON.stringify(callsFile)}; exit 0 ;;`,
          `    *) printf 'attach %s\\n' "$2" >> ${JSON.stringify(callsFile)}; exit 42 ;;`,
          '  esac',
          'fi',
          'exit 1',
          '',
        ].join('\n')
      );

      const result = spawnSync(
        '/bin/sh',
        ['-lc', buildZellijShellLine(sessionName, 'true', root)],
        {
          env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        }
      );

      expect(result.status).toBe(0);
      expect(readFileSync(callsFile, 'utf8').trim().split('\n')).toEqual([
        `attach ${sessionName}`,
        `delete ${sessionName}`,
        `create ${sessionName}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not treat exited resurrectable sessions as active', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'emdash-zellij-fake-'));
    const callsFile = path.join(root, 'calls.txt');
    const sessionName = 'emdash-fake.pty.leafhash00.session1.label';
    try {
      writeFileSync(callsFile, '');
      writeExecutable(
        path.join(root, 'zellij'),
        [
          '#!/bin/sh',
          'if [ "$1" = "list-sessions" ]; then',
          `  printf '%s [Created today] (EXITED - attach to resurrect)\\n' ${JSON.stringify(sessionName)}`,
          '  exit 0',
          'fi',
          'if [ "$1" = "delete-session" ]; then',
          `  printf 'delete %s\\n' "$2" >> ${JSON.stringify(callsFile)}`,
          '  exit 0',
          'fi',
          'if [ "$1" = "attach" ]; then',
          '  case " $* " in',
          `    *" --create "*) printf 'create %s\\n' "$3" >> ${JSON.stringify(callsFile)}; exit 0 ;;`,
          `    *) printf 'attach %s\\n' "$2" >> ${JSON.stringify(callsFile)}; exit 0 ;;`,
          '  esac',
          'fi',
          'exit 1',
          '',
        ].join('\n')
      );

      const result = spawnSync(
        '/bin/sh',
        ['-lc', buildZellijShellLine(sessionName, 'true', root)],
        {
          env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        }
      );

      expect(result.status).toBe(0);
      expect(readFileSync(callsFile, 'utf8').trim().split('\n')).toEqual([
        `delete ${sessionName}`,
        `create ${sessionName}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans the temporary layout directory after foreground attach exits', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'emdash-zellij-fake-'));
    const tmpRoot = path.join(root, 'tmp');
    try {
      mkdirSync(tmpRoot);
      writeExecutable(
        path.join(root, 'zellij'),
        [
          '#!/bin/sh',
          'if [ "$1" = "list-sessions" ]; then exit 0; fi',
          'if [ "$1" = "delete-session" ]; then exit 0; fi',
          'if [ "$1" = "attach" ]; then',
          '  case " $* " in *" --create "*) exit 0 ;; esac',
          'fi',
          'if [ "$1" = "attach" ]; then exit 0; fi',
          'exit 1',
          '',
        ].join('\n')
      );

      const result = spawnSync(
        '/bin/sh',
        ['-lc', buildZellijShellLine('emdash-fake.pty.leaf.session.label', 'true', root)],
        {
          env: {
            ...process.env,
            EMDASH_ZELLIJ_LAYOUT_CLEANUP_DELAY_SECONDS: '0',
            PATH: `${root}:${process.env.PATH ?? ''}`,
            TMPDIR: tmpRoot,
          },
          encoding: 'utf8',
        }
      );

      expect(result.status).toBe(0);
      expect(readdirSync(tmpRoot).filter((entry) => entry.startsWith('emdash-zellij.'))).toEqual(
        []
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('killZellijSessionsForPtySessionId', () => {
  it('kills every emdash zellij session whose hashes match the PTY session id', async () => {
    const sessionId = makePtySessionId('proj-1', 'task-2', 'conv-3');
    const matchingA = makeZellijSessionName(sessionId, 'Claude Chat');
    const matchingB = makeZellijSessionName(sessionId, 'Renamed Chat');
    const other = makeZellijSessionName(makePtySessionId('proj-1', 'task-2', 'other'), 'Other');
    const { ctx, calls } = makeCtx(`${matchingA}\n${matchingB}\n${other}\nforeign\n`);

    await killZellijSessionsForPtySessionId(ctx, sessionId);

    expect(
      calls.filter((call) => call.command === 'zellij' && call.args[0] === 'delete-session')
    ).toEqual([
      { command: 'zellij', args: ['delete-session', '--force', matchingA] },
      { command: 'zellij', args: ['delete-session', '--force', matchingB] },
    ]);
  });
});
