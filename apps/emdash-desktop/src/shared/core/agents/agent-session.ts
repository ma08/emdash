import type { AgentProviderId } from '@shared/core/agents/agent-provider-registry';
import type { MultiplexerSession } from '@shared/core/pty/session-multiplexer';

export interface AgentSessionConfig {
  taskId: string;
  conversationId: string;
  providerId: AgentProviderId;
  command: string;
  args: string[];
  cwd: string;
  sessionId?: string;
  shellSetup?: string;
  multiplexerSession?: MultiplexerSession;
  autoApprove: boolean;
  resume: boolean;
}
