import { getWindowsEnvValue } from '#primitives/agent-env/api';
import { formatCommandLine, quoteArg, type NativeInvocation } from '#primitives/exec/api';
import { planExecutableLaunch, type FileExists } from '#primitives/exec/node';
import { buildTmuxShellLine } from './tmux';
import { buildZellijShellLine } from './zellij';

export type ResolvedPtyShellProfile = {
  id: string;
  resolvedShellId: string;
  resolvedFromSystem: boolean;
  executable: string;
  available?: true;
  family: 'posix' | 'csh' | 'windows-cmd' | 'powershell' | 'wsl';
  interactiveArgs: string[];
  commandArgs: string[];
  envCaptureArgs?: string[];
  capturedEnv?: Record<string, string>;
  remotePathLookup?: boolean;
};

export type PtyCommandSpec =
  | { kind: 'argv'; command: string; args: string[] }
  | { kind: 'shell-line'; commandLine: string };

export type PtySpawnIntent =
  | {
      kind: 'interactive-shell';
      cwd: string;
      shellProfile?: ResolvedPtyShellProfile;
      shellSetup?: string;
      tmuxSessionName?: string;
      zellijSessionName?: string;
    }
  | {
      kind: 'run-command';
      cwd: string;
      command: PtyCommandSpec;
      shellProfile?: ResolvedPtyShellProfile;
      shellSetup?: string;
      tmuxSessionName?: string;
      zellijSessionName?: string;
    };

export type LocalPtySpawnWarning = 'tmux_unsupported_on_windows' | 'zellij_unsupported_on_windows';

export type ResolvedLocalPtySpawn = {
  invocation: NativeInvocation;
  cwd: string;
  warnings: LocalPtySpawnWarning[];
};

function argvInvocation(executable: string, argv: readonly string[]): NativeInvocation {
  return { kind: 'argv', executable, argv: [...argv] };
}

function windowsCommandLineInvocation(
  executable: string,
  argumentPrefix: readonly string[],
  commandLine: string
): NativeInvocation {
  return {
    kind: 'windows-command-line',
    executable,
    rawArguments: [...argumentPrefix, wrapCmdExeCommandLine(commandLine)].join(' '),
  };
}

function getPosixShell(env: NodeJS.ProcessEnv): string {
  return env.SHELL || '/bin/sh';
}

function getWindowsShell(env: NodeJS.ProcessEnv): string {
  return getWindowsEnvValue(env, 'ComSpec') || 'C:\\Windows\\System32\\cmd.exe';
}

function getResolvedShell(intent: PtySpawnIntent, env: NodeJS.ProcessEnv): string {
  return intent.shellProfile?.executable ?? getPosixShell(env);
}

function getInteractiveArgs(intent: PtySpawnIntent): string[] {
  return intent.shellProfile?.interactiveArgs ?? ['-il'];
}

function getCommandArgs(intent: PtySpawnIntent): string[] {
  return intent.shellProfile?.commandArgs ?? ['-c'];
}

function getSetupWrapperArgs(intent: PtySpawnIntent): string[] {
  if (!intent.shellProfile) return ['-c'];
  switch (intent.shellProfile.family) {
    case 'posix':
    case 'csh':
      return ['-c'];
    case 'windows-cmd':
    case 'powershell':
    case 'wsl':
      return intent.shellProfile.commandArgs;
  }
}

function argvToPosixShellLine(intent: PtySpawnIntent, command: string, args: string[]): string {
  const family = intent.shellProfile?.family === 'csh' ? 'csh' : 'posix';
  return formatCommandLine({ command, args }, family);
}

function wrapCmdExeCommandLine(commandLine: string): string {
  return commandLine.startsWith('"') ? `"${commandLine}"` : commandLine;
}

function windowsWarnings(intent: PtySpawnIntent): LocalPtySpawnWarning[] {
  const warnings: LocalPtySpawnWarning[] = [];
  if (intent.tmuxSessionName) warnings.push('tmux_unsupported_on_windows');
  if (intent.zellijSessionName) warnings.push('zellij_unsupported_on_windows');
  return warnings;
}

function hasMultiplexer(intent: PtySpawnIntent): boolean {
  return Boolean(intent.tmuxSessionName || intent.zellijSessionName);
}

/**
 * Wraps `commandLine` in the persistent-session multiplexer the intent asks
 * for. tmux takes precedence should both names be present. The zellij pane
 * runs the command through the resolved shell so no extra `/bin/sh` hop sits
 * between the multiplexer and a TUI agent.
 */
function multiplexerShellLine(
  intent: PtySpawnIntent,
  commandLine: string,
  shell: string,
  commandArgs: readonly string[]
): string | null {
  if (intent.tmuxSessionName) return buildTmuxShellLine(intent.tmuxSessionName, commandLine);
  if (intent.zellijSessionName) {
    return buildZellijShellLine(intent.zellijSessionName, commandLine, intent.cwd, {
      shell,
      shellArgs: commandArgs,
      outerShellFamily: intent.shellProfile?.family === 'csh' ? 'csh' : 'posix',
    });
  }
  return null;
}

function combineShellSetup(
  setup: string | undefined,
  commandLine: string,
  family: ResolvedPtyShellProfile['family']
): string {
  if (!setup) return commandLine;
  if (family === 'powershell') return `${setup}\nif ($?) {\n${commandLine}\n}`;
  return `${setup} && ${commandLine}`;
}

function windowsShellLineSpawn({
  commandLine,
  cwd,
  env,
  shellProfile,
  warnings,
}: {
  commandLine: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  shellProfile: PtySpawnIntent['shellProfile'];
  warnings: LocalPtySpawnWarning[];
}): ResolvedLocalPtySpawn {
  const shell = shellProfile?.executable ?? getWindowsShell(env);
  const commandArgs = shellProfile?.commandArgs ?? ['/d', '/s', '/c'];
  return {
    invocation:
      shellProfile?.family === 'powershell' || shellProfile?.family === 'wsl'
        ? argvInvocation(shell, [...commandArgs, commandLine])
        : windowsCommandLineInvocation(shell, commandArgs, commandLine),
    cwd,
    warnings,
  };
}

function resolveWindowsSpawn(
  intent: PtySpawnIntent,
  env: NodeJS.ProcessEnv,
  fileExists?: FileExists
): ResolvedLocalPtySpawn {
  const warnings = windowsWarnings(intent);
  const shell = intent.shellProfile?.executable ?? getWindowsShell(env);

  if (intent.kind === 'interactive-shell') {
    if (intent.shellSetup) {
      const family = intent.shellProfile?.family ?? 'windows-cmd';
      if (family === 'windows-cmd') {
        return {
          invocation: windowsCommandLineInvocation(shell, ['/d', '/s', '/k'], intent.shellSetup),
          cwd: intent.cwd,
          warnings,
        };
      }
      if (family === 'powershell') {
        return {
          invocation: argvInvocation(shell, ['-NoExit', '-Command', intent.shellSetup]),
          cwd: intent.cwd,
          warnings,
        };
      }
      const interactiveArgs = intent.shellProfile?.interactiveArgs ?? [];
      const reenter = formatCommandLine(
        { command: shell, args: interactiveArgs },
        family === 'csh' ? 'csh' : 'posix'
      );
      return windowsShellLineSpawn({
        commandLine: combineShellSetup(intent.shellSetup, `exec ${reenter}`, family),
        cwd: intent.cwd,
        env,
        shellProfile: intent.shellProfile,
        warnings,
      });
    }
    return {
      invocation: argvInvocation(shell, intent.shellProfile?.interactiveArgs ?? []),
      cwd: intent.cwd,
      warnings,
    };
  }

  if (intent.command.kind === 'shell-line') {
    const family = intent.shellProfile?.family ?? 'windows-cmd';
    return windowsShellLineSpawn({
      commandLine: combineShellSetup(intent.shellSetup, intent.command.commandLine, family),
      cwd: intent.cwd,
      env,
      shellProfile: intent.shellProfile,
      warnings,
    });
  }

  const { command, args } = intent.command;
  if (intent.shellSetup) {
    const family = intent.shellProfile?.family ?? 'windows-cmd';
    return windowsShellLineSpawn({
      commandLine: combineShellSetup(
        intent.shellSetup,
        formatCommandLine({ command, args }, family),
        family
      ),
      cwd: intent.cwd,
      env,
      shellProfile: intent.shellProfile,
      warnings,
    });
  }
  if (intent.shellProfile?.family === 'wsl') {
    return windowsShellLineSpawn({
      commandLine: argvToPosixShellLine(intent, command, args),
      cwd: intent.cwd,
      env,
      shellProfile: intent.shellProfile,
      warnings,
    });
  }

  const plan = planExecutableLaunch({
    platform: 'win32',
    command,
    args,
    cwd: intent.cwd,
    env,
    shellProfile: intent.shellProfile,
    fileExists,
  });
  return { invocation: plan.invocation, cwd: intent.cwd, warnings };
}

function resolvePosixSpawn(
  intent: PtySpawnIntent,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): ResolvedLocalPtySpawn {
  const shell = getResolvedShell(intent, env);
  const interactiveArgs = getInteractiveArgs(intent);
  const commandArgs = getCommandArgs(intent);
  const setupWrapperArgs = getSetupWrapperArgs(intent);

  if (intent.kind === 'interactive-shell') {
    if (hasMultiplexer(intent)) {
      const commandLine = intent.shellSetup
        ? `${intent.shellSetup} && exec ${quoteArg(shell, 'posix')} ${interactiveArgs.join(' ')}`
        : `exec ${quoteArg(shell, 'posix')} ${interactiveArgs.join(' ')}`;
      return {
        invocation: argvInvocation(shell, [
          ...(intent.shellSetup ? setupWrapperArgs : commandArgs),
          multiplexerShellLine(intent, commandLine, shell, commandArgs) ?? commandLine,
        ]),
        cwd: intent.cwd,
        warnings: [],
      };
    }

    if (intent.shellSetup) {
      return {
        invocation: argvInvocation(shell, [
          ...setupWrapperArgs,
          `${intent.shellSetup} && exec ${quoteArg(shell, 'posix')} ${interactiveArgs.join(' ')}`,
        ]),
        cwd: intent.cwd,
        warnings: [],
      };
    }

    return {
      invocation: argvInvocation(shell, interactiveArgs),
      cwd: intent.cwd,
      warnings: [],
    };
  }

  if (
    intent.shellProfile?.family === 'powershell' ||
    intent.shellProfile?.family === 'windows-cmd' ||
    intent.shellProfile?.family === 'wsl'
  ) {
    throw new Error(
      `Cannot run POSIX shell-wrapped commands through ${intent.shellProfile.resolvedShellId}`
    );
  }

  if (intent.command.kind === 'argv' && !intent.shellSetup && !hasMultiplexer(intent)) {
    const plan = planExecutableLaunch({
      platform,
      command: intent.command.command,
      args: intent.command.args,
      cwd: intent.cwd,
      env,
    });
    return { invocation: plan.invocation, cwd: intent.cwd, warnings: [] };
  }

  const commandLine =
    intent.command.kind === 'shell-line'
      ? intent.command.commandLine
      : argvToPosixShellLine(intent, intent.command.command, intent.command.args);
  const fullCommandLine = intent.shellSetup
    ? `${intent.shellSetup} && ${commandLine}`
    : commandLine;

  const multiplexed = multiplexerShellLine(intent, fullCommandLine, shell, commandArgs);
  if (multiplexed) {
    return {
      invocation: argvInvocation(shell, [...commandArgs, multiplexed]),
      cwd: intent.cwd,
      warnings: [],
    };
  }

  return {
    invocation: argvInvocation(shell, [...commandArgs, fullCommandLine]),
    cwd: intent.cwd,
    warnings: [],
  };
}

export function resolveLocalPtySpawn({
  intent,
  platform,
  env,
  fileExists,
}: {
  intent: PtySpawnIntent;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fileExists?: FileExists;
}): ResolvedLocalPtySpawn {
  return platform === 'win32'
    ? resolveWindowsSpawn(intent, env, fileExists)
    : resolvePosixSpawn(intent, env, platform);
}

export function logLocalPtySpawnWarnings(
  source: string,
  warnings: LocalPtySpawnWarning[],
  context: Record<string, string>,
  logger: { warn(message: string, context: Record<string, unknown>): void } = console
): void {
  if (warnings.length === 0) return;
  logger.warn(`${source}: local PTY platform warning`, { ...context, warnings });
}
