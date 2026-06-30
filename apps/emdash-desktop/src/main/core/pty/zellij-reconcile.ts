import type { IExecutionContext } from '@main/core/execution-context/types';
import { getProjectSessionLeafIds } from '@main/core/tasks/session-targets';
import { log } from '@main/lib/logger';
import {
  killZellijSession,
  listEmdashZellijSessions,
  parseZellijSessionName,
  zellijLeafHash,
  zellijProjectHash,
} from './zellij-session';

/**
 * Reap orphaned emdash zellij sessions for `projectId` on the context's host.
 *
 * Mirrors tmux reconciliation: only sessions that decode to this project are
 * considered, lifecycle-script sessions are preserved, and live DB leaf ids are
 * kept for resumability.
 */
export async function reconcileProjectZellijSessions(
  ctx: IExecutionContext,
  projectId: string
): Promise<void> {
  const sessionNames = await listEmdashZellijSessions(ctx);
  if (sessionNames.length === 0) return;

  const projectHash = zellijProjectHash(projectId);
  const candidates: Array<{ name: string; leafHash: string }> = [];
  for (const name of sessionNames) {
    const parsed = parseZellijSessionName(name);
    if (!parsed || parsed.projectHash !== projectHash) continue;
    if (parsed.leafKind === 'life') continue;
    candidates.push({ name, leafHash: parsed.leafHash });
  }
  if (candidates.length === 0) return;

  const { conversationIds, terminalIds } = await getProjectSessionLeafIds(projectId);
  const wantedLeafHashes = new Set([...conversationIds, ...terminalIds].map(zellijLeafHash));

  const orphans = candidates
    .filter(({ leafHash }) => !wantedLeafHashes.has(leafHash))
    .map(({ name }) => name);

  if (orphans.length === 0) return;

  log.info('reconcileProjectZellijSessions: reaping orphaned zellij sessions', {
    projectId,
    count: orphans.length,
  });
  await Promise.all(orphans.map((name) => killZellijSession(ctx, name)));
}
