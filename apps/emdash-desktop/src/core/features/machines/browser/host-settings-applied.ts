import type {
  HostSettingsState,
  UpdateHostSettingsInput,
} from '@emdash/core/runtimes/host-settings/api';

/**
 * Confirms a host accepted the minor-gated fields of a settings patch. A
 * workspace server that predates a field strips it from the patch and still
 * reports success, so the returned state is the only evidence that the value
 * was stored. Throws with a message fit for the user when it was not.
 */
export function assertHostSettingsApplied(
  patch: UpdateHostSettingsInput,
  state: HostSettingsState
): void {
  if (typeof patch.multiplexer === 'string' && state.settings.multiplexer !== patch.multiplexer) {
    throw new Error(
      'The workspace server on this host does not support choosing a session multiplexer yet. Update it, then choose again.'
    );
  }
}
