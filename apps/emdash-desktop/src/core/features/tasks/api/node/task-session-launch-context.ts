import {
  ZELLIJ_PROTOCOL_MINOR,
  type SessionMultiplexer,
} from '@emdash/core/primitives/session-multiplexer/api';
import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@emdash/shared/logger';
import { and, eq, isNull } from 'drizzle-orm';
import type { ProjectAttachmentError } from '@core/features/projects/api';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import { resolveProjectEffectiveSettings } from '@core/features/projects/api/node/settings/effective-settings';
import { getTaskEnvVars } from '@core/features/workspaces/api/node/workspace-env';
import type {
  WorkspaceIdentity,
  WorkspaceIdentityService,
} from '@core/features/workspaces/api/node/workspace-identity-service';
import type { AppDb } from '@core/services/app-db/node/db';
import { tasks } from '@core/services/app-db/node/schema';

export type TaskSessionLaunchContext = Readonly<{
  workspace: WorkspaceIdentity;
  /** Persistent sessions on for this launch; `multiplexer` says which kind. */
  tmux: boolean;
  multiplexer: SessionMultiplexer;
  /** Human-readable task name, the label persistent zellij sessions carry. */
  taskName: string;
  shellSetup?: string;
  env: Readonly<Record<string, string>>;
}>;

export type TaskSessionLaunchContextInput = Readonly<{
  projectId: string;
  taskId: string;
  workspaceId?: string;
}>;

export type TaskSessionLaunchContextError =
  | ProjectAttachmentError
  | { type: 'missing-task'; message: string }
  | { type: 'missing-workspace'; message: string };

export type TaskSessionLaunchContextSource = Readonly<{
  resolve(): Promise<Result<TaskSessionLaunchContext, TaskSessionLaunchContextError>>;
}>;

/**
 * Negotiated workspace-server protocol for a host. `null` means no protocol
 * applies (the local host runs the current code in-process) or it is unknown,
 * in which case the caller does not gate.
 */
export type HostProtocolSource = Readonly<{
  agreedMinor(host: WorkspaceIdentity['host']): Promise<number | null>;
}>;

export class TaskSessionLaunchContextResolver {
  constructor(
    private readonly dependencies: Readonly<{
      db: AppDb;
      projects: Pick<ProjectAttachmentManager, 'requireAttached'>;
      runtimes: Pick<RuntimeBroker, 'client'>;
      workspaceIdentity: Pick<WorkspaceIdentityService, 'resolve'>;
      hostProtocol?: HostProtocolSource;
    }>
  ) {}

  bind(input: TaskSessionLaunchContextInput): TaskSessionLaunchContextSource {
    return { resolve: () => this.resolve(input) };
  }

  async resolve(
    input: TaskSessionLaunchContextInput
  ): Promise<Result<TaskSessionLaunchContext, TaskSessionLaunchContextError>> {
    const [task] = await this.dependencies.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, input.taskId),
          eq(tasks.projectId, input.projectId),
          isNull(tasks.deletedAt)
        )
      )
      .limit(1);
    if (!task) {
      return err({ type: 'missing-task', message: `Task ${input.taskId} not found` });
    }
    if (!task.workspaceId) {
      return err({
        type: 'missing-workspace',
        message: `Task ${input.taskId} has no workspace`,
      });
    }
    if (input.workspaceId !== undefined && task.workspaceId !== input.workspaceId) {
      return err({
        type: 'missing-workspace',
        message: `Task ${input.taskId} is not bound to workspace ${input.workspaceId}`,
      });
    }

    const project = this.dependencies.projects.requireAttached(input.projectId);
    if (!project.success) return project;

    const identity = await this.dependencies.workspaceIdentity.resolve(task.workspaceId);
    if (!identity || identity.projectId !== input.projectId) {
      return err({
        type: 'missing-workspace',
        message: `Workspace ${task.workspaceId} was not found`,
      });
    }

    const runtime = await this.dependencies.runtimes.client(identity.host);
    if (!runtime.success) return runtime;

    const [effective, tmux, multiplexer, projectConfig] = await Promise.all([
      resolveProjectEffectiveSettings({
        settings: project.data.settings,
        repoFacts: project.data.repoFacts,
      }),
      project.data.settings.resolveTmux(),
      project.data.settings.resolveMultiplexer(),
      runtime.data.workspaceRegistry.getProjectConfig({ workspaceId: identity.workspaceId }),
    ]);
    if (!projectConfig.success) {
      return err({
        type: 'missing-workspace',
        message: `Workspace ${identity.workspaceId} has no project configuration`,
      });
    }

    return ok({
      workspace: identity,
      tmux: resolveSessionTmux(identity.host, tmux.value),
      multiplexer: await this.resolveSessionMultiplexer(identity, multiplexer.value),
      taskName: task.name,
      shellSetup: projectConfig.data.resolved.shellSetup?.value,
      env: {
        ...projectConfig.data.resolved.env.value,
        ...getTaskEnvVars({
          taskId: task.id,
          taskName: task.name,
          taskPath: identity.path,
          projectPath: project.data.repoPath,
          defaultBranch: effective.defaultBranch.value?.branch ?? null,
          portSeed: identity.path,
        }),
      },
    });
  }

  /**
   * zellij is an additive protocol feature (minor `ZELLIJ_PROTOCOL_MINOR`).
   * A remote host whose workspace-server negotiated an older minor would
   * strip the zellij fields and run the session without persistence, so such
   * a host falls back to tmux and says so in the log. The local host runs the
   * current runtimes in-process and is never gated.
   */
  private async resolveSessionMultiplexer(
    identity: WorkspaceIdentity,
    requested: SessionMultiplexer
  ): Promise<SessionMultiplexer> {
    if (
      requested !== 'zellij' ||
      identity.host.type === 'local' ||
      !this.dependencies.hostProtocol
    ) {
      return requested;
    }
    const agreedMinor = await this.dependencies.hostProtocol.agreedMinor(identity.host);
    if (agreedMinor === null || agreedMinor >= ZELLIJ_PROTOCOL_MINOR) return requested;
    log.warn(
      'TaskSessionLaunchContext: host workspace-server predates zellij support; using tmux',
      {
        host: identity.host.id,
        agreedMinor,
        required: ZELLIJ_PROTOCOL_MINOR,
      }
    );
    return 'tmux';
  }
}

export function resolveSessionTmux(
  host: WorkspaceIdentity['host'],
  requested: boolean,
  platform: NodeJS.Platform = process.platform
): boolean {
  return host.type === 'local' && platform === 'win32' ? false : requested;
}
