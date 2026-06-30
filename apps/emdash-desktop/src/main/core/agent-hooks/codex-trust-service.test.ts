import * as toml from 'smol-toml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
import {
  FileSystemError,
  FileSystemErrorCodes,
  type FileSystemProvider,
} from '@main/core/fs/types';
import { CodexTrustService } from './codex-trust-service';

const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockRename = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    rename: mockRename,
    rm: mockRm,
  },
}));

vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: { get: vi.fn() },
}));

vi.mock('@main/lib/logger', () => ({
  log: {
    warn: mockWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function nodeNotFound(): NodeJS.ErrnoException {
  return Object.assign(new Error('not found'), { code: 'ENOENT' });
}

function fsNotFound(pathName: string): FileSystemError {
  return new FileSystemError(
    `File not found: ${pathName}`,
    FileSystemErrorCodes.NOT_FOUND,
    pathName
  );
}

function makeService(overrides: { autoTrustWorktrees?: boolean } = {}): CodexTrustService {
  return new CodexTrustService({
    getTaskSettings: () =>
      Promise.resolve({ autoTrustWorktrees: overrides.autoTrustWorktrees ?? true }),
  });
}

function makeRemoteFs(
  overrides: Partial<Pick<FileSystemProvider, 'realPath' | 'read' | 'write'>> = {}
): Pick<FileSystemProvider, 'realPath' | 'read' | 'write'> {
  return {
    realPath: vi.fn(async (p: string) => p),
    read: vi.fn().mockRejectedValue(fsNotFound('/home/remote-user/.codex/config.toml')),
    write: vi.fn().mockResolvedValue({ success: true, bytesWritten: 0 }),
    ...overrides,
  };
}

function makeCtx(): IExecutionContext {
  return {
    root: undefined,
    supportsLocalSpawn: false,
    exec: vi.fn().mockImplementation(async (command: string) => {
      if (command === 'sh') return { stdout: '/home/remote-user', stderr: '' };
      return { stdout: '', stderr: '' };
    }),
    execStreaming: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('CodexTrustService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockRejectedValue(nodeNotFound());
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  it('skips non-Codex providers', async () => {
    const service = makeService();

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('skips when auto-trust is disabled', async () => {
    const service = makeService({ autoTrustWorktrees: false });

    await service.maybeAutoTrustLocal({
      providerId: 'codex',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('trusts Codex workspaces when forced even if auto-trust is disabled', async () => {
    const service = makeService({ autoTrustWorktrees: false });

    await service.maybeAutoTrustLocal({
      providerId: 'codex',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
      force: true,
    });

    expect(mockReadFile).toHaveBeenCalledWith('/home/local-user/.codex/config.toml', 'utf8');
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('adds the local workspace to Codex projects without dropping existing config', async () => {
    const service = makeService();
    mockReadFile.mockResolvedValue(
      'model = "gpt-5"\n\n[projects."/already"]\ntrust_level = "trusted"\n'
    );

    await service.maybeAutoTrustLocal({
      providerId: 'codex',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockMkdir).toHaveBeenCalledWith('/home/local-user/.codex', { recursive: true });
    const [tmpPath, content] = mockWriteFile.mock.calls[0];
    const [renameFrom, renameTo] = mockRename.mock.calls[0];
    expect(tmpPath).toContain('/home/local-user/.codex/config.toml.');
    expect(renameFrom).toBe(tmpPath);
    expect(renameTo).toBe('/home/local-user/.codex/config.toml');

    const written = toml.parse(String(content)) as Record<string, unknown>;
    expect(written.model).toBe('gpt-5');
    expect((written.projects as Record<string, Record<string, string>>)['/already']).toEqual({
      trust_level: 'trusted',
    });
    expect((written.projects as Record<string, Record<string, string>>)['/tmp/worktree']).toEqual({
      trust_level: 'trusted',
    });
  });

  it('does not rewrite when the Codex workspace is already trusted', async () => {
    const service = makeService();
    mockReadFile.mockResolvedValue('[projects."/tmp/worktree"]\ntrust_level = "trusted"\n');

    await service.maybeAutoTrustLocal({
      providerId: 'codex',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a non-object Codex project entry', async () => {
    const service = makeService();
    mockReadFile.mockResolvedValue('[projects]\n"/tmp/worktree" = "trusted"\n');

    await service.maybeAutoTrustLocal({
      providerId: 'codex',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'CodexTrustService: refusing to overwrite non-object Codex project entry',
      { path: '/tmp/worktree' }
    );
  });

  it('refuses to overwrite corrupt TOML and logs a warning', async () => {
    const service = makeService();
    mockReadFile.mockResolvedValue('[projects."\n');

    await service.maybeAutoTrustLocal({
      providerId: 'codex',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'CodexTrustService: refusing to overwrite corrupt Codex config',
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('writes ssh config and renames the tmp file remotely', async () => {
    const service = makeService();
    const remoteFs = makeRemoteFs({
      realPath: vi.fn().mockResolvedValue('/remote/worktree'),
    });
    const ctx = makeCtx();

    await service.maybeAutoTrustSsh({
      providerId: 'codex',
      cwd: '/remote/worktree',
      ctx,
      remoteFs,
    });

    expect(remoteFs.read).toHaveBeenCalledWith('/home/remote-user/.codex/config.toml', 2_097_152);
    expect(ctx.exec).toHaveBeenCalledWith('mkdir', ['-p', '/home/remote-user/.codex']);
    expect(remoteFs.write).toHaveBeenCalledTimes(1);

    const [tmpPath, content] = vi.mocked(remoteFs.write).mock.calls[0];
    expect(tmpPath).toContain('/home/remote-user/.codex/config.toml.');
    expect(ctx.exec).toHaveBeenCalledWith('mv', [tmpPath, '/home/remote-user/.codex/config.toml']);
    const written = toml.parse(String(content)) as Record<string, unknown>;
    expect(
      (written.projects as Record<string, Record<string, string>>)['/remote/worktree']
    ).toEqual({
      trust_level: 'trusted',
    });
  });
});
