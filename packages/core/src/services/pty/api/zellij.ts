import type { IExecutionContext } from '#primitives/exec/api';
import { listZellijSessions, type ZellijSessionInventoryEntry } from './zellij-commands';
import { makeZellijSessionName, zellijSessionBelongsTo } from './zellij-identity';

export type ResolvedZellijSession = {
  name: string;
  /** True when zellij is running a session for the identity; `name` is that session. */
  exists: boolean;
};

/**
 * The zellij counterpart of `resolveTmuxSession`. A running session for the
 * identity wins under whatever label it was created with, so a renamed
 * worktree still attaches; otherwise the canonical name for the current label
 * is returned for creation.
 */
export async function resolveZellijSession(
  ctx: IExecutionContext,
  input: { identity: string; label: string }
): Promise<ResolvedZellijSession> {
  const running = runningZellijSessionFor(await listZellijSessions(ctx), input.identity);
  if (running) return { name: running, exists: true };
  return { name: makeZellijSessionName(input.identity, input.label), exists: false };
}

/** Every listed session, running or exited, that belongs to one of the identities. */
export async function findZellijSessionNamesByIdentity(
  ctx: IExecutionContext,
  identities: readonly string[]
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  if (identities.length === 0) return found;
  for (const session of await listZellijSessions(ctx)) {
    for (const identity of identities) {
      if (!zellijSessionBelongsTo(session.name, identity)) continue;
      found.set(identity, [...(found.get(identity) ?? []), session.name]);
    }
  }
  return found;
}

export function runningZellijSessionFor(
  sessions: readonly ZellijSessionInventoryEntry[],
  identity: string
): string | undefined {
  return sessions.find(
    (session) => session.active && zellijSessionBelongsTo(session.name, identity)
  )?.name;
}

/**
 * Emdash finds its zellij sessions by listing them in the host's zellij
 * namespace. A session launched with another `ZELLIJ_SOCKET_DIR`, for example
 * from a project's environment settings, would be invisible to resolve,
 * reconcile and cleanup, so a zellij launch keeps the host's value.
 */
export function pinZellijNamespace(
  launchEnv: Record<string, string>,
  hostEnv: Record<string, string | undefined>
): Record<string, string> {
  const { ZELLIJ_SOCKET_DIR: _override, ...env } = launchEnv;
  const hostSocketDir = hostEnv['ZELLIJ_SOCKET_DIR'];
  return hostSocketDir ? { ...env, ZELLIJ_SOCKET_DIR: hostSocketDir } : env;
}
