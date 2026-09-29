import { hostRef } from '@emdash/core/primitives/host/api';
import { describe, expect, it, vi } from 'vitest';
import { readAgreedProtocolMinor } from './agreed-protocol-minor';
import type { Hosts } from './hosts';

const remote = hostRef('remote', 'ssh-1');

function hostsWith(client: (options?: { signal?: AbortSignal }) => Promise<unknown>) {
  return {
    get: vi.fn(() => ({ runtime: { client } })),
  } as unknown as Pick<Hosts, 'get'>;
}

describe('readAgreedProtocolMinor', () => {
  it('returns the minor negotiated on a usable connection', async () => {
    const hosts = hostsWith(async () => ({ ready: async () => ({ agreedMinor: 1 }) }));

    await expect(readAgreedProtocolMinor(hosts, remote)).resolves.toBe(1);
    expect(hosts.get).toHaveBeenCalledWith(remote);
  });

  it('is unknown for a host that is not managed', async () => {
    const hosts = { get: vi.fn(() => undefined) } as unknown as Pick<Hosts, 'get'>;

    await expect(readAgreedProtocolMinor(hosts, remote)).resolves.toBeNull();
  });

  it('is unknown when the connection or the handshake fails', async () => {
    const refused = hostsWith(async () => {
      throw new Error('Host runtime is not currently usable');
    });
    const noHandshake = hostsWith(async () => ({
      ready: async () => {
        throw new Error('Host handshake is unavailable');
      },
    }));

    await expect(readAgreedProtocolMinor(refused, remote)).resolves.toBeNull();
    await expect(readAgreedProtocolMinor(noHandshake, remote)).resolves.toBeNull();
  });

  it('gives up on a host that stays disconnected and cancels the wait', async () => {
    let waitSignal: AbortSignal | undefined;
    const hosts = hostsWith(
      (options) =>
        new Promise(() => {
          waitSignal = options?.signal;
        })
    );

    await expect(readAgreedProtocolMinor(hosts, remote, { timeoutMs: 20 })).resolves.toBeNull();
    expect(waitSignal?.aborted).toBe(true);
  });
});
