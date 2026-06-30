import type { MultiplexerSession } from '@shared/core/pty/session-multiplexer';

export interface GeneralSession {
  type: 'general';
  config: GeneralSessionConfig;
}

export interface GeneralSessionConfig {
  taskId?: string;
  cwd: string;
  projectPath?: string;
  shellSetup?: string;
  multiplexerSession?: MultiplexerSession;
  command?: string;
  args?: string[];
}
