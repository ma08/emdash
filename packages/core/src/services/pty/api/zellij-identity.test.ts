import { describe, expect, it } from 'vitest';
import {
  makeZellijSessionName,
  ZELLIJ_NAME_MAX_LENGTH,
  zellijIdentityHash,
  zellijSessionBelongsTo,
  zellijSessionLabel,
} from './zellij-identity';

const IDENTITY = 'project-1:task-1:conversation-1';

describe('makeZellijSessionName', () => {
  it('combines a readable label with a deterministic identity hash', () => {
    const name = makeZellijSessionName(IDENTITY, 'Fix login');

    expect(name).toBe(`fix-login-${zellijIdentityHash(IDENTITY)}`);
    expect(name).toMatch(/^[a-z0-9_-]+-[0-9a-f]{10}$/);
    expect(makeZellijSessionName(IDENTITY, 'Fix login')).toBe(name);
    expect(makeZellijSessionName('project-1:task-1:conversation-2', 'Fix login')).not.toBe(name);
  });

  it('keeps every name within the macOS socket path budget', () => {
    const identity = `${'p'.repeat(64)}:${'t'.repeat(64)}:${'c'.repeat(64)}`;
    const name = makeZellijSessionName(identity, 'a-very-long-worktree-directory-name');

    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(ZELLIJ_NAME_MAX_LENGTH);
    // Default macOS TMPDIR (49) + zellij-<uid>/ (12) + contract_version_1/ (19) + name.
    expect(49 + 12 + 19 + Buffer.byteLength(name)).toBeLessThanOrEqual(103);
  });

  it('reduces labels to ASCII so the length cap is a byte cap', () => {
    const name = makeZellijSessionName(IDENTITY, 'Café 🚀 déjà-vu');

    expect(name).toMatch(/^[a-z0-9_-]+-[0-9a-f]{10}$/);
    expect(Buffer.byteLength(name)).toBe(name.length);
  });

  it('falls back to a generic label and never ends the label with a separator', () => {
    const hash = zellijIdentityHash(IDENTITY);

    expect(makeZellijSessionName(IDENTITY, '---')).toBe(`session-${hash}`);
    expect(makeZellijSessionName(IDENTITY, '🚀')).toBe(`session-${hash}`);
    expect(makeZellijSessionName(IDENTITY)).toBe(`session-${hash}`);
    expect(makeZellijSessionName(IDENTITY, 'abcdefghij-tail')).toBe(`abcdefghij-${hash}`);
    expect(makeZellijSessionName(IDENTITY, 'abcdefghijklmnop')).toBe(`abcdefghijk-${hash}`);
  });
});

describe('zellijSessionBelongsTo', () => {
  it('matches a session to its identity under any label', () => {
    expect(zellijSessionBelongsTo(makeZellijSessionName(IDENTITY, 'old-name'), IDENTITY)).toBe(
      true
    );
    expect(zellijSessionBelongsTo(makeZellijSessionName(IDENTITY, 'new-name'), IDENTITY)).toBe(
      true
    );
    expect(zellijSessionBelongsTo(makeZellijSessionName(IDENTITY, 'x'), 'another-identity')).toBe(
      false
    );
  });

  it('ignores names that do not have the generated shape', () => {
    const hash = zellijIdentityHash(IDENTITY);

    expect(zellijSessionBelongsTo('scratch', IDENTITY)).toBe(false);
    expect(zellijSessionBelongsTo(hash, IDENTITY)).toBe(false);
    expect(zellijSessionBelongsTo(`-${hash}`, IDENTITY)).toBe(false);
    expect(zellijSessionBelongsTo(`My Work-${hash}`, IDENTITY)).toBe(false);
    expect(zellijSessionBelongsTo(`work-${hash}-copy`, IDENTITY)).toBe(false);
  });
});

describe('zellijSessionLabel', () => {
  it('returns the readable part of a generated name', () => {
    expect(zellijSessionLabel(makeZellijSessionName(IDENTITY, 'My Task'))).toBe('my-task');
    expect(zellijSessionLabel('scratch')).toBe('session');
  });
});
