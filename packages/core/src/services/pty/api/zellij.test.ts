import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '#primitives/exec/api';
import { findZellijSessionNamesByIdentity, resolveZellijSession } from './zellij';
import { makeZellijSessionName } from './zellij-identity';

const IDENTITY = 'project-1:task-1:conversation-1';
const OTHER_IDENTITY = 'project-1:task-1:conversation-2';

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

function listing(...lines: string[]): IExecutionContext {
  return stubExecContext(vi.fn(async () => ({ stdout: `${lines.join('\n')}\n`, stderr: '' })));
}

describe('resolveZellijSession', () => {
  it('returns the canonical name when no session is running for the identity', async () => {
    const ctx = listing(`${makeZellijSessionName(OTHER_IDENTITY, 'tree')} [Created 1m ago]`);

    await expect(resolveZellijSession(ctx, { identity: IDENTITY, label: 'tree' })).resolves.toEqual(
      { name: makeZellijSessionName(IDENTITY, 'tree'), exists: false }
    );
  });

  it('prefers a running session created under an earlier label', async () => {
    const created = makeZellijSessionName(IDENTITY, 'old-name');
    const ctx = listing(`${created} [Created 1m ago]`);

    await expect(
      resolveZellijSession(ctx, { identity: IDENTITY, label: 'new-name' })
    ).resolves.toEqual({ name: created, exists: true });
  });

  it('does not treat an exited remnant as a running session', async () => {
    const name = makeZellijSessionName(IDENTITY, 'tree');
    const ctx = listing(`${name} [Created 1m ago] (EXITED - attach to resurrect)`);

    await expect(resolveZellijSession(ctx, { identity: IDENTITY, label: 'tree' })).resolves.toEqual(
      { name, exists: false }
    );
  });

  it('resolves to the canonical name when zellij is not installed', async () => {
    const ctx = stubExecContext(
      vi.fn(async () => {
        throw { exitCode: 127, stderr: 'sh: zellij: command not found' };
      })
    );

    await expect(resolveZellijSession(ctx, { identity: IDENTITY, label: 'tree' })).resolves.toEqual(
      { name: makeZellijSessionName(IDENTITY, 'tree'), exists: false }
    );
  });
});

describe('findZellijSessionNamesByIdentity', () => {
  it('collects running and exited sessions for each identity under any label', async () => {
    const running = makeZellijSessionName(IDENTITY, 'new-name');
    const exited = makeZellijSessionName(IDENTITY, 'old-name');
    const other = makeZellijSessionName(OTHER_IDENTITY, 'new-name');
    const ctx = listing(
      `${exited} [Created 2m ago] (EXITED - attach to resurrect)`,
      `${running} [Created 1m ago]`,
      `${other} [Created 1m ago]`,
      'scratch [Created 1m ago]'
    );

    const found = await findZellijSessionNamesByIdentity(ctx, [IDENTITY, 'unknown']);

    expect(found).toEqual(new Map([[IDENTITY, [exited, running]]]));
  });

  it('does not list sessions when there is nothing to look for', async () => {
    const exec = vi.fn();

    await expect(findZellijSessionNamesByIdentity(stubExecContext(exec), [])).resolves.toEqual(
      new Map()
    );
    expect(exec).not.toHaveBeenCalled();
  });
});
