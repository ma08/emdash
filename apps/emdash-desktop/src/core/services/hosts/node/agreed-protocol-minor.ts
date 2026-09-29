import type { HostRef } from '@emdash/core/primitives/host/api';
import { runWithTimeout, type Clock } from '@emdash/shared/scheduling';
import type { Hosts } from './hosts';

/** How long a launch may wait for a host connection before its level counts as unknown. */
export const AGREED_PROTOCOL_MINOR_TIMEOUT_MS = 5_000;

/**
 * The workspace-server protocol minor negotiated with a remote host, read
 * from a usable connection. Returns `null` when it cannot be determined in
 * time: the host is not managed, cannot be reached, or stays disconnected.
 * Callers gating a minor-guarded feature treat `null` as "not supported".
 */
export async function readAgreedProtocolMinor(
  hosts: Pick<Hosts, 'get'>,
  host: HostRef,
  options: { timeoutMs?: number; clock?: Clock } = {}
): Promise<number | null> {
  const service = hosts.get(host);
  if (!service) return null;
  try {
    return await runWithTimeout(
      async (signal) => {
        const connection = await service.runtime.client({ signal });
        return (await connection.ready()).agreedMinor;
      },
      { timeoutMs: options.timeoutMs ?? AGREED_PROTOCOL_MINOR_TIMEOUT_MS, clock: options.clock }
    );
  } catch {
    return null;
  }
}
