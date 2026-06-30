import type { PersistentSessionMultiplexer } from '@shared/core/project-settings/project-settings';

export type MultiplexerSession = {
  kind: PersistentSessionMultiplexer;
  sessionName: string;
  displayName?: string;
};
