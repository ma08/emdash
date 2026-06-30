import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as toml from 'smol-toml';
import type { IExecutionContext } from '@main/core/execution-context/types';
import {
  FileSystemError,
  FileSystemErrorCodes,
  type FileSystemProvider,
} from '@main/core/fs/types';
import { appSettingsService } from '@main/core/settings/settings-service';
import { resolveRemoteHome } from '@main/core/ssh/lifecycle/remote-shell-profile';
import { log } from '@main/lib/logger';
import type { AgentProviderId } from '@shared/core/agents/agent-provider-registry';

const CODEX_PROVIDER_ID: AgentProviderId = 'codex';
const CODEX_CONFIG_NAME = '.codex/config.toml';
const CODEX_CONFIG_MAX_BYTES = 2 * 1024 * 1024;

export class CodexTrustService {
  private readonly configLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      getTaskSettings: () => Promise<{ autoTrustWorktrees: boolean }>;
    }
  ) {}

  async maybeAutoTrustLocal({
    providerId,
    cwd,
    homedir,
    force = false,
  }: {
    providerId: AgentProviderId;
    cwd?: string;
    homedir: string;
    force?: boolean;
  }): Promise<void> {
    if (!cwd) return;
    if (!(await this.shouldAutoTrust(providerId, force))) return;

    const workspacePath = path.resolve(cwd);
    const configPath = path.join(homedir, CODEX_CONFIG_NAME);
    await this.withLock(configPath, () =>
      this.ensureTrusted(workspacePath, {
        readConfig: () => readLocalConfig(configPath),
        writeConfig: (content) => writeLocalConfigAtomic(configPath, content),
      })
    );
  }

  async maybeAutoTrustSsh({
    providerId,
    cwd,
    ctx,
    remoteFs,
    force = false,
  }: {
    providerId: AgentProviderId;
    cwd?: string;
    ctx: IExecutionContext;
    remoteFs: Pick<FileSystemProvider, 'realPath' | 'read' | 'write'>;
    force?: boolean;
  }): Promise<void> {
    if (!cwd) return;
    if (!(await this.shouldAutoTrust(providerId, force))) return;

    const workspacePath = await remoteFs.realPath(cwd).catch(() => path.posix.resolve('/', cwd));
    const homeDir = await resolveRemoteHome(ctx);
    const configPath = path.posix.join(homeDir, CODEX_CONFIG_NAME);
    await this.withLock(configPath, () =>
      this.ensureTrusted(workspacePath, {
        readConfig: () => readRemoteConfig(remoteFs, configPath),
        writeConfig: (content) => writeRemoteConfigAtomic(remoteFs, ctx, configPath, content),
      })
    );
  }

  private async shouldAutoTrust(providerId: AgentProviderId, force: boolean): Promise<boolean> {
    if (providerId !== CODEX_PROVIDER_ID) return false;
    if (force) return true;
    const { autoTrustWorktrees } = await this.deps.getTaskSettings();
    return autoTrustWorktrees;
  }

  private withLock(configPath: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.configLocks.get(configPath) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.configLocks.set(configPath, next);
    return next;
  }

  private async ensureTrusted(
    workspacePath: string,
    io: {
      readConfig: () => Promise<string | null>;
      writeConfig: (content: string) => Promise<void>;
    }
  ): Promise<void> {
    try {
      const rawConfig = await io.readConfig();
      const config = parseCodexConfig(rawConfig);
      if (!config) return;
      const nextConfig = withTrustedCodexProject(config, workspacePath);
      if (!nextConfig) return;
      await io.writeConfig(toml.stringify(nextConfig));
    } catch (error: unknown) {
      log.warn('CodexTrustService: failed to auto-trust worktree', {
        path: workspacePath,
        error: String(error),
      });
    }
  }
}

export const codexTrustService = new CodexTrustService({
  getTaskSettings: () => appSettingsService.get('tasks'),
});

function parseCodexConfig(raw: string | null): Record<string, unknown> | null {
  if (!raw || raw.trim() === '') return {};

  try {
    const parsed = toml.parse(raw);
    if (isPlainObject(parsed)) return parsed;
    log.warn('CodexTrustService: refusing to overwrite non-object Codex config root');
    return null;
  } catch (error: unknown) {
    log.warn('CodexTrustService: refusing to overwrite corrupt Codex config', {
      error: String(error),
    });
    return null;
  }
}

function withTrustedCodexProject(
  config: Record<string, unknown>,
  workspacePath: string
): Record<string, unknown> | null {
  if (config.projects !== undefined && !isPlainObject(config.projects)) {
    log.warn('CodexTrustService: refusing to overwrite non-object Codex projects table');
    return null;
  }

  const projects = isPlainObject(config.projects) ? config.projects : {};
  const current = projects[workspacePath];
  if (current !== undefined && !isPlainObject(current)) {
    log.warn('CodexTrustService: refusing to overwrite non-object Codex project entry', {
      path: workspacePath,
    });
    return null;
  }

  const existing = current ?? {};
  if (existing.trust_level === 'trusted') return null;

  return {
    ...config,
    projects: {
      ...projects,
      [workspacePath]: {
        ...existing,
        trust_level: 'trusted',
      },
    },
  };
}

async function readLocalConfig(configPath: string): Promise<string | null> {
  try {
    return await fs.readFile(configPath, 'utf8');
  } catch (error: unknown) {
    if (isNodeNotFound(error)) return null;
    throw error;
  }
}

async function writeLocalConfigAtomic(configPath: string, content: string): Promise<void> {
  const tmpPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, configPath);
  } catch (error: unknown) {
    try {
      await fs.rm(tmpPath, { force: true });
    } catch {}
    throw error;
  }
}

async function readRemoteConfig(
  remoteFs: Pick<FileSystemProvider, 'read'>,
  configPath: string
): Promise<string | null> {
  try {
    const result = await remoteFs.read(configPath, CODEX_CONFIG_MAX_BYTES);
    return result.content;
  } catch (error: unknown) {
    if (isFsNotFound(error)) return null;
    throw error;
  }
}

async function writeRemoteConfigAtomic(
  remoteFs: Pick<FileSystemProvider, 'write'>,
  ctx: IExecutionContext,
  configPath: string,
  content: string
): Promise<void> {
  const tmpPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await ctx.exec('mkdir', ['-p', path.posix.dirname(configPath)]);
    await remoteFs.write(tmpPath, content);
    await ctx.exec('mv', [tmpPath, configPath]);
  } catch (error: unknown) {
    try {
      await ctx.exec('rm', ['-f', tmpPath]);
    } catch {}
    throw error;
  }
}

function isNodeNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isFsNotFound(error: unknown): boolean {
  return error instanceof FileSystemError && error.code === FileSystemErrorCodes.NOT_FOUND;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
