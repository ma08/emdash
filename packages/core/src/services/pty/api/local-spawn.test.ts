import { describe, expect, it } from 'vitest';
import type { ResolvedPtyShellProfile } from './local-spawn';
import { resolveLocalPtySpawn } from './local-spawn';

const powershellProfile: ResolvedPtyShellProfile = {
  id: 'pwsh',
  resolvedShellId: 'pwsh',
  resolvedFromSystem: false,
  executable: 'C:\\Program Files\\PowerShell\\pwsh.exe',
  family: 'powershell',
  interactiveArgs: ['-NoLogo'],
  commandArgs: ['-NoLogo', '-Command'],
};

describe('resolveLocalPtySpawn', () => {
  it('keeps plain POSIX argv launches direct', () => {
    expect(
      resolveLocalPtySpawn({
        platform: 'linux',
        env: { SHELL: '/bin/zsh' },
        intent: {
          kind: 'run-command',
          cwd: '/workspace',
          command: { kind: 'argv', command: '/opt/provider', args: ['run', 'hello world'] },
        },
      })
    ).toEqual({
      invocation: {
        kind: 'argv',
        executable: '/opt/provider',
        argv: ['run', 'hello world'],
      },
      cwd: '/workspace',
      warnings: [],
    });
  });

  it('runs cmd shims through cmd even when PowerShell is the selected profile', () => {
    const shim = 'C:\\Program Files\\npm\\provider.cmd';
    const resolved = resolveLocalPtySpawn({
      platform: 'win32',
      env: {
        Path: 'C:\\Program Files\\npm',
        PATHEXT: '.EXE;.CMD',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      },
      intent: {
        kind: 'run-command',
        cwd: 'C:\\workspace',
        command: { kind: 'argv', command: 'provider', args: ['run', 'hello world'] },
        shellProfile: powershellProfile,
      },
      fileExists: (candidate) => candidate.toLowerCase() === shim.toLowerCase(),
    });

    expect(resolved).toMatchObject({
      invocation: {
        kind: 'windows-command-line',
        executable: 'C:\\Windows\\System32\\cmd.exe',
        rawArguments: expect.stringMatching(/^\/d \/s \/c .*provider\.cmd/i),
      },
      warnings: [],
    });
  });

  it('uses the selected PowerShell profile for ps1 files', () => {
    const script = 'C:\\Program Files\\Provider\\provider.ps1';
    const resolved = resolveLocalPtySpawn({
      platform: 'win32',
      env: {},
      intent: {
        kind: 'run-command',
        cwd: 'C:\\workspace',
        command: { kind: 'argv', command: script, args: ['run'] },
        shellProfile: powershellProfile,
      },
      fileExists: (candidate) => candidate === script,
    });

    expect(resolved).toMatchObject({
      invocation: {
        kind: 'argv',
        executable: powershellProfile.executable,
        argv: ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', script, 'run'],
      },
    });
  });

  it('runs setup and a command in the selected Windows PowerShell profile', () => {
    const resolved = resolveLocalPtySpawn({
      platform: 'win32',
      env: {},
      intent: {
        kind: 'run-command',
        cwd: 'C:\\workspace',
        command: { kind: 'shell-line', commandLine: 'pnpm install' },
        shellSetup: '$env:COREPACK_HOME = "C:\\Corepack"',
        shellProfile: powershellProfile,
      },
    });

    expect(resolved).toEqual({
      invocation: {
        kind: 'argv',
        executable: powershellProfile.executable,
        argv: [
          '-NoLogo',
          '-Command',
          '$env:COREPACK_HOME = "C:\\Corepack"\nif ($?) {\npnpm install\n}',
        ],
      },
      cwd: 'C:\\workspace',
      warnings: [],
    });
  });

  it.each([
    {
      name: 'cmd',
      platform: 'win32' as const,
      executable: 'C:\\Windows\\System32\\cmd.exe',
      family: 'windows-cmd' as const,
      commandArgs: ['/d', '/s', '/c'],
    },
    {
      name: 'Windows PowerShell',
      platform: 'win32' as const,
      executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      family: 'powershell' as const,
      commandArgs: ['-NoProfile', '-Command'],
    },
    {
      name: 'pwsh',
      platform: 'win32' as const,
      executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      family: 'powershell' as const,
      commandArgs: ['-NoProfile', '-Command'],
    },
    {
      name: 'WSL',
      platform: 'win32' as const,
      executable: 'C:\\Windows\\System32\\wsl.exe',
      family: 'wsl' as const,
      commandArgs: ['--exec', 'sh', '-lc'],
    },
    {
      name: 'POSIX',
      platform: 'linux' as const,
      executable: '/bin/sh',
      family: 'posix' as const,
      commandArgs: ['-c'],
    },
    {
      name: 'csh',
      platform: 'linux' as const,
      executable: '/bin/csh',
      family: 'csh' as const,
      commandArgs: ['-c'],
    },
  ])('uses the declared $name profile for shell-line commands', (entry) => {
    const resolved = resolveLocalPtySpawn({
      platform: entry.platform,
      env: {},
      intent: {
        kind: 'run-command',
        cwd: entry.platform === 'win32' ? 'C:\\workspace' : '/workspace',
        command: { kind: 'shell-line', commandLine: 'echo ready' },
        shellProfile: {
          id: 'target-default',
          resolvedShellId: entry.family === 'csh' ? 'csh' : 'sh',
          resolvedFromSystem: false,
          executable: entry.executable,
          family: entry.family,
          interactiveArgs: [],
          commandArgs: entry.commandArgs,
        },
      },
    });

    expect(resolved.invocation.executable).toBe(entry.executable);
    if (resolved.invocation.kind === 'windows-command-line') {
      expect(resolved.invocation.rawArguments).toBe(`${entry.commandArgs.join(' ')} echo ready`);
    } else {
      expect(resolved.invocation.argv.slice(0, entry.commandArgs.length)).toEqual(
        entry.commandArgs
      );
    }
  });
});

describe('resolveLocalPtySpawn with a zellij session', () => {
  const env = { SHELL: '/bin/zsh' } as NodeJS.ProcessEnv;

  it('wraps interactive shells in the zellij attach script', () => {
    const resolved = resolveLocalPtySpawn({
      intent: {
        kind: 'interactive-shell',
        cwd: '/work/tree',
        zellijSessionName: 'emdash-my-task.abcdefghij',
      },
      platform: 'darwin',
      env,
    });

    expect(resolved.warnings).toEqual([]);
    expect(resolved.invocation.kind).toBe('argv');
    if (resolved.invocation.kind !== 'argv') throw new Error('expected argv invocation');
    expect(resolved.invocation.executable).toBe('/bin/zsh');
    expect(resolved.invocation.argv[0]).toBe('-c');
    const script = resolved.invocation.argv[1] ?? '';
    expect(script.startsWith('/bin/sh -c ')).toBe(true);
    expect(script).toContain('zellij attach --create');
    expect(script).toContain('emdash-my-task.abcdefghij');
    expect(script).toContain('pane command="/bin/zsh" cwd="/work/tree"');
    expect(script).toContain('args "-c" "exec /bin/zsh -il"');
  });

  it('wraps commands in the zellij attach script and keeps shell setup', () => {
    const resolved = resolveLocalPtySpawn({
      intent: {
        kind: 'run-command',
        cwd: '/work/tree',
        command: { kind: 'argv', command: 'codex', args: ['--resume', 'abc'] },
        shellSetup: 'source ~/.nvm/nvm.sh',
        zellijSessionName: 'emdash-my-task.abcdefghij',
      },
      platform: 'linux',
      env,
    });

    if (resolved.invocation.kind !== 'argv') throw new Error('expected argv invocation');
    expect(resolved.invocation.executable).toBe('/bin/zsh');
    const script = resolved.invocation.argv[1] ?? '';
    expect(script).toContain('zellij attach --create');
    expect(script).toContain('args "-c" "source ~/.nvm/nvm.sh && codex --resume abc"');
    expect(script).not.toContain('tmux');
  });

  it('prefers tmux when both multiplexer names are present', () => {
    const resolved = resolveLocalPtySpawn({
      intent: {
        kind: 'run-command',
        cwd: '/work/tree',
        command: { kind: 'argv', command: 'codex', args: [] },
        tmuxSessionName: 'emdash-tmux',
        zellijSessionName: 'emdash-my-task.abcdefghij',
      },
      platform: 'linux',
      env,
    });

    if (resolved.invocation.kind !== 'argv') throw new Error('expected argv invocation');
    expect(resolved.invocation.argv[1]).toContain('tmux');
    expect(resolved.invocation.argv[1]).not.toContain('zellij');
  });

  it('warns and skips the multiplexer on Windows', () => {
    const resolved = resolveLocalPtySpawn({
      intent: {
        kind: 'interactive-shell',
        cwd: 'C:\\work',
        zellijSessionName: 'emdash-my-task.abcdefghij',
      },
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } as NodeJS.ProcessEnv,
    });

    expect(resolved.warnings).toEqual(['zellij_unsupported_on_windows']);
    expect(JSON.stringify(resolved.invocation)).not.toContain('zellij');
  });
});
