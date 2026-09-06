import { err, ok, type Result, type Serializable } from '@emdash/shared';
import { KeyedMutex } from '@emdash/shared/concurrency';
import { systemClock, type Clock } from '@emdash/shared/scheduling';
import { LiveLogSource } from '@emdash/wire/live';
import { type LiveSource } from '@emdash/wire/rpc';
import { peek } from '@emdash/wire/state';
import { currentAgentEnvPlatform, mergeAgentEnvLayers } from '#primitives/agent-env/api';
import { applyGitCredentialsToEnv } from '#primitives/git-credentials/api';
import type {
  PersistedTuiAgentStartInput,
  TuiAgentStartInput,
  TuiInputError,
  TuiResumeOutcome,
  TuiResumeError,
  TuiSessionControlError,
  TuiSessionState,
  TuiStartOutcome,
  TuiStartError,
} from '#runtimes/tui-agents/api';
import { persistedTuiAgentStartInputSchema } from '#runtimes/tui-agents/api';
import { TuiHookPipeline } from '#runtimes/tui-agents/node/hooks/hook-pipeline';
import { TuiHookServer } from '#runtimes/tui-agents/node/hooks/hook-server';
import {
  createTuiAgentStatesLiveModel,
  createTuiAgentStatesListModel,
  createTuiSessionsLiveModel,
  createTuiSessionsListModel,
  produceCell,
  type TuiAgentStatesLiveModel,
  type TuiAgentStatesListModel,
  type TuiSessionsLiveModel,
  type TuiSessionsListModel,
} from '#runtimes/tui-agents/node/state/live-models';
import { TuiWorkspaceTrust } from '#runtimes/tui-agents/node/trust/workspace-trust';
import type { AgentCommand, ResolvedTuiProvider } from '#services/agent-plugins/api/plugins';
import { AgentHookInstaller } from '#services/agent-plugins/node';
import {
  noopConversationLifecycleReporter,
  type ConversationLifecycleReporter,
} from '#services/conversation-reports/node';
import {
  activeZellijSessionFor,
  killTmuxSession,
  killZellijSessionsMatching,
  listTmuxSessionActivity,
  listZellijSessions,
  logLocalPtySpawnWarnings,
  PtyRegistry,
  resolveLocalPtySpawn,
  type PtyExitInfo,
  type PtySession,
  type PtySpawnSpec,
  type ZellijSessionInfo,
} from '#services/pty/api';
import { resolveTerminalShell } from '#services/pty/node';
import type { SessionIntent } from '#services/session-intents/api';
import {
  SESSION_IDLE_MS,
  type ActivityFields,
  type ConversationSessionLifecycle,
  type SessionSnapshotJudgment,
} from '#services/session-lifecycle/api';
import { createSessionLifecycle } from '#services/session-lifecycle/node';
import { TuiAgentStates } from './agent-state';
import { spillLargePrompt, type PromptSpillResult } from './prompt-spill';
import type { TuiAgentsRuntimeDeps, TuiSessionConfig } from './types';

const RESUME_FALLBACK_WINDOW_MS = 3_000;
const RESPAWN_DELAY_MS = 500;
const MAX_UNEXPECTED_RESPAWNS = 1;
const BUSY_OUTPUT_WINDOW_MS = 60_000;

type TuiAgentSession = {
  conversationId: string;
  output: LiveLogSource;
  pty: PtySession | null;
  config: TuiSessionConfig | null;
  provider: ResolvedTuiProvider | null;
};

export class TuiAgentsRuntime {
  private readonly registry: PtyRegistry;
  private readonly launchMutex = new KeyedMutex();
  private readonly sessions = new Map<string, TuiAgentSession>();
  private readonly logs = new Map<string, LiveLogSource>();
  private readonly configs = new Map<string, TuiSessionConfig>();
  private readonly generations = new Map<string, number>();
  readonly sessionsLiveModel: TuiSessionsLiveModel;
  readonly agentStatesLiveModel: TuiAgentStatesLiveModel;
  private readonly sessionsList: TuiSessionsListModel;
  private readonly agentStatesList: TuiAgentStatesListModel;
  private readonly agentStates: TuiAgentStates;
  private readonly hookInstaller: AgentHookInstaller;
  private readonly hookServer: TuiHookServer;
  private readonly hookPipeline: TuiHookPipeline;
  private readonly workspaceTrust: TuiWorkspaceTrust;
  private readonly clock: Clock;
  private readonly lifecycle: ConversationSessionLifecycle;
  private tmuxActivity = new Map<string, number>();
  /**
   * zellij liveness table for the reconcile gate and for idle sweeps. zellij
   * reports no activity timestamps, so while a PTY client is attached the
   * activity tracker is the only signal (output flows through the PTY). Once
   * the client is gone (detach key, client crash) a still-running zellij
   * session counts as busy so the sweep never force-deletes a working agent;
   * tmux gets the same protection from its activity timestamps.
   */
  private zellijSessions = new Map<string, ZellijSessionInfo>();
  /** True when the last sweep-side zellij listing failed: assume detached sessions are alive. */
  private zellijListingFailed = false;
  private readonly unexpectedRespawns = new Map<string, number>();
  private readonly promptSpills = new Map<string, PromptSpillResult>();
  /**
   * The session's tmux side can outlive the pty client; output inside tmux is
   * invisible to the activity tracker, so `busy` keeps such sessions alive for
   * the same window the idle policy grants tracker output.
   */
  private readonly tmuxKeepAliveMs: number;
  private readonly reports: ConversationLifecycleReporter;

  constructor(private readonly deps: TuiAgentsRuntimeDeps) {
    this.reports = deps.conversationReports ?? noopConversationLifecycleReporter;
    this.registry = new PtyRegistry(deps.spawner);
    this.clock = deps.clock ?? systemClock;
    this.sessionsLiveModel = createTuiSessionsLiveModel();
    this.agentStatesLiveModel = createTuiAgentStatesLiveModel();
    this.sessionsList = createTuiSessionsListModel(this.sessionsLiveModel);
    this.agentStatesList = createTuiAgentStatesListModel(this.agentStatesLiveModel);
    this.agentStates = new TuiAgentStates(
      this.sessionsList,
      this.agentStatesList,
      () => this.clock.now(),
      (conversationId, providerSessionId) => {
        this.lifecycle.saveIntent(conversationId);
        // Hook-driven session-id capture reports through the same surface as ACP rebinds.
        this.lifecycle.providerSessionId(conversationId, { conversationId, providerSessionId });
      },
      (conversationId) => {
        this.lifecycle.saveIntent(conversationId);
      }
    );
    this.hookInstaller = new AgentHookInstaller({ agentHost: deps.agentHost, logger: deps.logger });
    this.workspaceTrust = new TuiWorkspaceTrust({
      agentHost: deps.agentHost,
      logger: deps.logger,
    });
    this.hookPipeline = new TuiHookPipeline({
      getConversationConfig: (conversationId) => {
        const config = this.configs.get(conversationId);
        if (!config) return null;
        return {
          conversationId,
          providerId: config.input.providerId,
        };
      },
      getProvider: (providerId) => this.deps.agentHost.resolveTuiProvider(providerId),
      applyCanonicalEvent: (conversationId, providerId, event) =>
        this.agentStates.applyCanonicalEvent(conversationId, providerId, event),
      logger: deps.logger,
    });
    this.hookServer = new TuiHookServer((raw) => this.hookPipeline.handle(raw), deps.logger);
    const sessionPolicy = deps.lifecycle?.session;
    this.tmuxKeepAliveMs =
      sessionPolicy?.kind === 'idle-after' ? sessionPolicy.outputMs : SESSION_IDLE_MS;
    this.lifecycle = createSessionLifecycle<PersistedTuiAgentStartInput, void>({
      name: 'TuiAgentsRuntime',
      logger: deps.logger,
      clock: this.clock,
      idlePolicy: sessionPolicy,
      sweepIntervalMs: deps.lifecycle?.sweepIntervalMs,
      beforeSweep: async () => {
        if ((this.deps.platform ?? process.platform) === 'win32') {
          this.tmuxActivity = new Map();
          return;
        }
        // Skip the tmux subprocess entirely when nothing is tracked; the sweep
        // below iterates the same (empty) config set.
        if (this.configs.size === 0) {
          this.tmuxActivity = new Map();
          this.zellijSessions = new Map();
          return;
        }
        this.tmuxActivity = await listTmuxSessionActivity(this.deps.exec);
        await this.refreshDetachedZellijLiveness();
      },
      entries: () => this.configs.keys(),
      snapshot: (conversationId, activity) => this.lifecycleSnapshot(conversationId, activity),
      syncListEntry: (conversationId, activity) =>
        this.syncSessionActivity(conversationId, activity),
      deactivate: async (conversationId, cause) => {
        await this.deactivateSession(conversationId, cause);
      },
      evictSteps: [
        {
          name: 'generation',
          run: (key) => {
            // Deleting (not bumping) both cancels in-flight spawns and clears the key.
            this.generations.delete(key);
          },
        },
        {
          name: 'unexpected-respawns',
          run: (key) => {
            this.unexpectedRespawns.delete(key);
          },
        },
        {
          name: 'multiplexer-session',
          run: (key) => this.killMultiplexerForConfig(this.configs.get(key)),
        },
        {
          name: 'pty-registry',
          run: (key) => {
            this.registry.dispose(key);
          },
        },
        {
          name: 'prompt-spill',
          run: (key) => this.cleanupPromptSpill(key),
        },
        {
          name: 'config',
          run: (key) => {
            this.configs.delete(key);
          },
        },
        {
          name: 'log',
          run: (key) => {
            this.logs.delete(key);
          },
        },
        {
          name: 'retained-session',
          run: (key) => {
            const active = this.sessions.get(key);
            active?.output.reseed();
            this.sessions.delete(key);
          },
        },
        {
          name: 'sessions-list-entry',
          run: (key) => {
            produceCell(this.sessionsList.states.list, (draft) => {
              delete draft[key];
            });
          },
        },
        { name: 'agent-state', run: (key) => this.agentStates.clear(key) },
      ],
      conversation: {
        intents: deps.intents,
        reports: deps.conversationReports,
        activePayload: (conversationId) => {
          const config = this.configs.get(conversationId);
          if (!config) return null;
          const { initialPrompt: _initialPrompt, ...persisted } = config.input;
          const sessionId = this.currentProviderSessionId(conversationId, config.input.sessionId);
          const lastAgentState = this.agentStates.current(conversationId);
          return {
            payload: { ...persisted, sessionId, lastAgentState } as unknown as Serializable,
            sessionId,
          };
        },
        reconcile: {
          precheck: async (intents) => {
            if ((this.deps.platform ?? process.platform) === 'win32') {
              this.tmuxActivity = new Map();
              this.zellijSessions = new Map();
              return { ctx: undefined };
            }
            try {
              // The prefetch doubles as the gate's liveness table; a listing
              // failure vetoes the whole run (intents stay untouched). Each
              // multiplexer is consulted only when an active intent needs it,
              // so a host without one of them never blocks the other.
              this.tmuxActivity = intents.some(intentUsesTmux)
                ? await listTmuxSessionActivity(this.deps.exec)
                : new Map();
              this.zellijSessions = intents.some(intentUsesZellij)
                ? await listZellijSessions(this.deps.exec)
                : new Map();
              return { ctx: undefined };
            } catch (error) {
              return { veto: true as const, error };
            }
          },
          parse: (intent) => {
            const parsed = persistedTuiAgentStartInputSchema.safeParse(intent.payload);
            if (!parsed.success) return { suspend: 'reconcile-failed' };
            if (parsed.data.lastAgentState) {
              this.agentStates.restore(parsed.data.lastAgentState);
            }
            return { input: this.normalizePlatformInput(parsed.data) };
          },
          gate: (input) => {
            if (!this.multiplexerSessionAlive(input)) return { suspend: 'process-lost' };
            return { ok: true as const };
          },
          resume: (input) => this.resumeSession(input),
        },
      },
    });
  }

  async startSession(
    input: TuiAgentStartInput
  ): Promise<Result<{ outcome: TuiStartOutcome }, TuiStartError>> {
    input = this.normalizePlatformInput(input);
    const provider = this.resolveProvider(input.providerId);
    if (!provider.success) return err(provider.error);

    return this.launchMutex.runExclusive(input.conversationId, async () => {
      const active = this.sessions.get(input.conversationId);
      if (active?.pty) return ok({ outcome: 'attached' });

      const preparedInput = await this.preparePromptInput(input);
      const config: TuiSessionConfig = { input: preparedInput, intent: 'fresh' };
      this.configs.set(input.conversationId, config);
      this.lifecycle.recordInput(input.conversationId);
      this.unexpectedRespawns.delete(input.conversationId);

      const generation = this.bumpGeneration(input.conversationId);
      const result = await this.spawnInto(
        this.sessionFor(input.conversationId),
        config,
        generation
      );
      if (!result.success) {
        await this.cleanupPromptSpill(input.conversationId);
        return result;
      }

      return ok({ outcome: 'started' });
    });
  }

  async resumeSession(
    input: TuiAgentStartInput
  ): Promise<Result<{ outcome: TuiResumeOutcome }, TuiResumeError>> {
    input = this.normalizePlatformInput(input);
    const provider = this.resolveProvider(input.providerId);
    if (!provider.success) return err(provider.error);

    return this.launchMutex.runExclusive(input.conversationId, async () => {
      const active = this.sessions.get(input.conversationId);
      if (active?.pty) return ok({ outcome: 'attached' });

      const intent = input.sessionId ? 'resume' : 'fresh';
      const preparedInput = intent === 'fresh' ? await this.preparePromptInput(input) : input;
      const config: TuiSessionConfig = {
        input: preparedInput,
        intent,
        ...(input.sessionId ? {} : { resumeFallback: true }),
      };
      this.configs.set(input.conversationId, config);
      this.lifecycle.recordInput(input.conversationId);
      this.unexpectedRespawns.delete(input.conversationId);
      this.setResumeState(input.conversationId, {
        requested: true,
        outcome: input.sessionId ? 'pending' : 'fresh-fallback',
        reason: input.sessionId ? undefined : 'missing-provider-session-id',
      });

      const generation = this.bumpGeneration(input.conversationId);
      const result = await this.spawnInto(
        this.sessionFor(input.conversationId),
        config,
        generation
      );
      if (!result.success) {
        await this.cleanupPromptSpill(input.conversationId);
        return result;
      }

      return ok({ outcome: input.sessionId ? 'resumed' : 'fresh-fallback' });
    });
  }

  async stopSession(conversationId: string): Promise<Result<void, TuiSessionControlError>> {
    this.bumpGeneration(conversationId);
    const config = this.configs.get(conversationId);
    if (config) this.configs.set(conversationId, { ...config, intent: 'stopped' });
    this.unexpectedRespawns.delete(conversationId);
    // Not awaited, but serialized with launches: the zellij kill lists and
    // deletes by id hash, so a restart must not create its session before
    // the stale cleanup has finished looking.
    void this.launchMutex.runExclusive(conversationId, () => this.killMultiplexerForConfig(config));
    this.registry.dispose(conversationId);
    const active = this.sessions.get(conversationId);
    if (active) active.pty = null;
    this.markExited(conversationId, null);
    this.agentStates.resetToIdle(conversationId);
    // Suspend-but-retain: scrollback, config tombstone, and list entry survive;
    // the stopped config keeps the key sweep-inert (snapshot returns null).
    this.lifecycle.end(conversationId, 'user');
    await this.cleanupPromptSpill(conversationId);
    return ok(undefined);
  }

  async deleteSession(conversationId: string): Promise<Result<void, TuiSessionControlError>> {
    await this.evictSerialized(conversationId, { cause: 'user', intent: 'remove' });
    return ok(undefined);
  }

  async deactivateSession(
    conversationId: string,
    cause: string
  ): Promise<Result<void, TuiSessionControlError>> {
    const config = this.configs.get(conversationId);
    if (!config || config.intent === 'stopped') return ok(undefined);
    await this.evictSerialized(conversationId, { cause, intent: 'suspend' });
    return ok(undefined);
  }

  async killSession(conversationId: string): Promise<Result<void, TuiSessionControlError>> {
    await this.evictSerialized(conversationId, { cause: 'user', intent: 'remove' });
    return ok(undefined);
  }

  /**
   * Eviction under the per-conversation launch mutex. The zellij kill inside
   * it lists and deletes sessions by id hash, so a start or resume that
   * overlaps an eviction must wait for the whole teardown rather than create
   * its session between two evict steps. Nothing evicts while holding the
   * mutex, so this cannot deadlock.
   */
  private evictSerialized(
    conversationId: string,
    options: Parameters<ConversationSessionLifecycle['evict']>[1]
  ): Promise<void> {
    return this.launchMutex.runExclusive(conversationId, () =>
      this.lifecycle.evict(conversationId, options)
    );
  }

  sendInput(conversationId: string, data: string): Result<void, TuiInputError> {
    const active = this.sessions.get(conversationId);
    if (!active?.pty) return err({ type: 'not-found', conversationId });
    active.pty.write(data);
    this.lifecycle.recordInput(conversationId);
    this.agentStates.markInputSubmitted(conversationId, active.provider, data);
    return ok(undefined);
  }

  resize(conversationId: string, cols: number, rows: number): Result<void, TuiInputError> {
    const active = this.sessions.get(conversationId);
    if (!active?.pty) return err({ type: 'not-found', conversationId });
    active.pty.resize(cols, rows);
    this.updateSessionSize(conversationId, cols, rows);
    return ok(undefined);
  }

  outputLog(key: { conversationId: string }): LiveSource {
    return {
      snapshot: async () => this.logFor(key.conversationId).snapshot(),
      subscribe: (cb) => {
        this.lifecycle.attach(key.conversationId);
        const unsubscribe = this.logFor(key.conversationId).subscribe(cb);
        return () => {
          this.lifecycle.detach(key.conversationId);
          unsubscribe();
        };
      },
    };
  }

  reconcile(): Promise<void> {
    return this.lifecycle.reconcile();
  }

  async dispose(): Promise<void> {
    this.lifecycle.dispose();
    for (const conversationId of this.sessions.keys()) {
      this.bumpGeneration(conversationId);
    }
    this.registry.killAll();
    this.hookServer.stop();
    await Promise.all([...this.promptSpills.keys()].map((key) => this.cleanupPromptSpill(key)));
    this.sessions.clear();
    this.logs.clear();
    this.configs.clear();
  }

  private async spawnInto(
    session: TuiAgentSession,
    config: TuiSessionConfig,
    generation: number
  ): Promise<Result<void, TuiStartError>> {
    const providerResult = this.resolveProvider(config.input.providerId);
    if (!providerResult.success) return err(providerResult.error);

    const provider = providerResult.data;
    const isResuming = config.intent === 'resume';
    const resumeState =
      isResuming ||
      this.currentResumeState(config.input.conversationId)?.outcome === 'fresh-fallback'
        ? (this.currentResumeState(config.input.conversationId) ?? {
            requested: true,
            outcome: 'pending' as const,
          })
        : null;
    const startedAt = this.clock.now();
    session.config = config;
    session.provider = provider;
    this.syncSessionState({
      conversationId: config.input.conversationId,
      providerId: config.input.providerId,
      cwd: config.input.cwd,
      sessionId: config.input.sessionId,
      status: 'starting',
      cols: config.input.cols,
      rows: config.input.rows,
      resume: resumeState,
      startedAt,
    });

    const commandResult = await this.deps.agentHost.buildPromptCommand(config.input.providerId, {
      extraArgs: config.input.extraArgs,
      autoApprove: config.input.autoApprove ?? false,
      initialPrompt: isResuming ? undefined : config.input.initialPrompt,
      sessionId: config.input.conversationId,
      providerSessionId: config.input.sessionId ?? undefined,
      isResuming,
      model: config.input.model ?? '',
    });
    if (!this.isCurrentGeneration(config.input.conversationId, generation)) {
      return this.cancelledSpawn(config.input.conversationId);
    }
    if (!commandResult.success) {
      const message = JSON.stringify(commandResult.error);
      this.markSpawnFailed(config, resumeState, startedAt, message);
      return err({ type: 'spawn-failed', conversationId: config.input.conversationId, message });
    }
    const command = commandResult.data;
    if (config.input.trustWorkspace === true) {
      await this.workspaceTrust.ensureTrusted({
        providerId: config.input.providerId,
        workspacePath: config.input.cwd,
      });
    }
    const hookEnv = await this.prepareHookEnv(config.input, provider);
    if (!this.isCurrentGeneration(config.input.conversationId, generation)) {
      return this.cancelledSpawn(config.input.conversationId);
    }

    // Git-credential behavior is applied last through the blessed construction (spec:
    // github-git-settings §4) so a "none" scrub wins over provider and hook env.
    const env = applyGitCredentialsToEnv(
      mergeAgentEnvLayers(
        currentAgentEnvPlatform(this.deps.platform),
        {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'emdash',
        },
        command.env,
        config.input.providerVars ?? {},
        hookEnv
      ),
      config.input.gitCredentials
    );
    const spawnSpec = await this.spawnSpec(command, config.input, env);
    if (!this.isCurrentGeneration(config.input.conversationId, generation)) {
      return this.cancelledSpawn(config.input.conversationId);
    }
    let pty: PtySession;
    try {
      pty = await this.registry.create(
        config.input.conversationId,
        {
          invocation: spawnSpec.invocation,
          cwd: config.input.cwd,
          env,
          cols: config.input.cols,
          rows: config.input.rows,
        },
        {
          output: session.output,
          onData: () => {
            this.lifecycle.recordOutput(config.input.conversationId);
          },
          onExit: (info) => {
            if (!this.isCurrentGeneration(config.input.conversationId, generation)) return;
            if (session.pty === pty) session.pty = null;
            if (isResuming && this.clock.now() - startedAt <= RESUME_FALLBACK_WINDOW_MS) {
              this.setResumeState(config.input.conversationId, {
                requested: true,
                outcome: 'fresh-fallback',
                reason: 'resume-process-exited-early',
              });
              const nextConfig: TuiSessionConfig = {
                input: config.input,
                intent: 'fresh',
                resumeFallback: true,
              };
              this.configs.set(config.input.conversationId, nextConfig);
              void this.launchCurrentConfig(config.input.conversationId);
              return;
            }
            this.markExited(config.input.conversationId, info);
            this.agentStates.resetToIdle(config.input.conversationId);
            if (this.maybeRespawnAfterUnexpectedExit(session, config, generation, info)) {
              // The respawn will report sessionStarted again; the active intent
              // stays live so a crash mid-respawn still reconciles.
              this.reports.sessionEnded(config.input.conversationId);
            } else {
              void this.cleanupPromptSpill(config.input.conversationId);
              this.lifecycle.end(config.input.conversationId, 'process-exited');
            }
          },
          onStateChange: () => {
            if (!this.isCurrentGeneration(config.input.conversationId, generation)) return;
            this.syncSessionState({
              conversationId: config.input.conversationId,
              providerId: config.input.providerId,
              cwd: config.input.cwd,
              sessionId: this.currentProviderSessionId(
                config.input.conversationId,
                config.input.sessionId
              ),
              status: pty.exited ? 'exited' : 'running',
              pid: pty.getPid(),
              cols: config.input.cols,
              rows: config.input.rows,
              resume: isResuming ? { requested: true, outcome: 'resumed' } : resumeState,
              startedAt,
              exit: pty.exitStatus
                ? { exitCode: pty.exitStatus.exitCode, signal: pty.exitStatus.signal ?? undefined }
                : undefined,
            });
          },
        }
      );
    } catch (error) {
      const message = String(error);
      this.markSpawnFailed(config, resumeState, startedAt, message);
      return err({ type: 'spawn-failed', conversationId: config.input.conversationId, message });
    }

    if (!this.isCurrentGeneration(config.input.conversationId, generation)) {
      pty.kill();
      return this.cancelledSpawn(config.input.conversationId);
    }

    session.pty = pty;
    // Lifecycle report (spec §7.4): a resume spawn is optimistically 'loaded' (the CLI owns
    // replay; early exit triggers the fresh-fallback respawn below, which reports
    // 'replaced-by-new'); a fresh-fallback respawn means history was not restored; a plain
    // fresh start is not a resume attempt at all. `started` also persists the active intent.
    this.lifecycle.started(config.input.conversationId, {
      conversationId: config.input.conversationId,
      // A resume attempt (re)asserts the handle it spawned with. A fresh spawn's
      // provider-native id is unknown until hook capture, but the caller may declare an
      // emdash-chosen resume handle up front (spec §3.1) — report it so the index holds
      // the handle the session will actually resume by.
      providerSessionId: isResuming
        ? (config.input.sessionId ?? null)
        : (config.input.chosenSessionId ?? null),
      resumeOutcome: isResuming ? 'loaded' : config.resumeFallback ? 'replaced-by-new' : null,
    });
    if (!isResuming) {
      this.agentStates.markInitialPromptSubmitted(
        config.input.conversationId,
        config.input.providerId,
        provider,
        config.input.initialPrompt
      );
    }
    this.syncSessionState({
      conversationId: config.input.conversationId,
      providerId: config.input.providerId,
      cwd: config.input.cwd,
      sessionId: this.currentProviderSessionId(config.input.conversationId, config.input.sessionId),
      status: 'running',
      pid: pty.getPid(),
      cols: config.input.cols,
      rows: config.input.rows,
      resume: isResuming ? { requested: true, outcome: 'resumed' } : resumeState,
      startedAt,
    });
    return ok(undefined);
  }
  private createRetainedSession(conversationId: string): TuiAgentSession {
    return {
      conversationId,
      output: this.logFor(conversationId),
      pty: null,
      config: null,
      provider: null,
    };
  }

  private async preparePromptInput(input: TuiAgentStartInput): Promise<TuiAgentStartInput> {
    if (!input.initialPrompt) return input;
    await this.cleanupPromptSpill(input.conversationId);
    const spill = await (
      this.deps.spillPrompt ??
      ((prompt) =>
        spillLargePrompt(prompt, {
          onError: (error, promptLength) =>
            this.deps.logger.warn('Failed to spill large TUI prompt; passing it inline', {
              conversationId: input.conversationId,
              promptLength,
              error: String(error),
            }),
        }))
    )(input.initialPrompt);
    if (spill.spilled) this.promptSpills.set(input.conversationId, spill);
    return spill.prompt === input.initialPrompt ? input : { ...input, initialPrompt: spill.prompt };
  }

  private async cleanupPromptSpill(conversationId: string): Promise<void> {
    const spill = this.promptSpills.get(conversationId);
    if (!spill) return;
    this.promptSpills.delete(conversationId);
    try {
      await spill.cleanup();
    } catch (error) {
      this.deps.logger.warn('Failed to remove TUI prompt file', {
        conversationId,
        error: String(error),
      });
    }
  }

  private sessionFor(conversationId: string): TuiAgentSession {
    let session = this.sessions.get(conversationId);
    if (!session) {
      session = this.createRetainedSession(conversationId);
      this.sessions.set(conversationId, session);
    }
    return session;
  }

  private bumpGeneration(conversationId: string): number {
    const next = (this.generations.get(conversationId) ?? 0) + 1;
    this.generations.set(conversationId, next);
    return next;
  }

  private isCurrentGeneration(conversationId: string, generation: number): boolean {
    return this.generations.get(conversationId) === generation;
  }

  private cancelledSpawn(conversationId: string): Result<void, TuiStartError> {
    return err({
      type: 'spawn-failed',
      conversationId,
      message: 'Launch was cancelled by a newer session operation',
    });
  }

  private markSpawnFailed(
    config: TuiSessionConfig,
    resume: TuiSessionState['resume'],
    startedAt: number,
    message: string
  ): void {
    this.syncSessionState({
      conversationId: config.input.conversationId,
      providerId: config.input.providerId,
      cwd: config.input.cwd,
      sessionId: config.input.sessionId,
      status: 'exited',
      cols: config.input.cols,
      rows: config.input.rows,
      resume,
      startedAt,
      exit: { exitCode: null, signal: 'spawn-failed' },
    });
    this.deps.logger.warn('TuiAgentsRuntime: failed to spawn session', {
      conversationId: config.input.conversationId,
      providerId: config.input.providerId,
      message,
    });
  }

  private async launchCurrentConfig(conversationId: string): Promise<void> {
    await this.launchMutex.runExclusive(conversationId, async () => {
      const session = this.sessions.get(conversationId);
      const config = this.configs.get(conversationId);
      if (!session || session.pty || !config || config.intent === 'stopped') return;

      const generation = this.bumpGeneration(conversationId);
      const result = await this.spawnInto(session, config, generation);
      if (result.success) return;

      await this.cleanupPromptSpill(conversationId);
      this.lifecycle.end(conversationId, 'spawn-failed');
      this.deps.logger.warn('TuiAgentsRuntime: respawn/fallback failed', {
        conversationId,
        error: result.error,
      });
    });
  }

  private logFor(conversationId: string): LiveLogSource {
    let log = this.logs.get(conversationId);
    if (!log) {
      log = new LiveLogSource(this.deps.log);
      this.logs.set(conversationId, log);
    }
    return log;
  }

  private resolveProvider(providerId: string): Result<ResolvedTuiProvider, TuiStartError> {
    const provider = this.deps.agentHost.resolveTuiProvider(providerId);
    if (provider) return ok(provider);
    return this.deps.agentHost.get(providerId)
      ? err({ type: 'no-command', providerId })
      : err({ type: 'unknown-provider', providerId });
  }

  private async prepareHookEnv(
    input: TuiAgentStartInput,
    provider: ResolvedTuiProvider
  ): Promise<Record<string, string>> {
    if (provider.hooks.kind === 'none') return {};

    const hooksAvailable = await this.hookInstaller.ensureHooksInstalled({
      providerId: input.providerId,
      workspacePath: input.cwd,
      env: input.providerVars,
    });
    if (!hooksAvailable) {
      this.deps.logger.warn(
        'TuiAgentsRuntime: hook installation unavailable; continuing with hook endpoint',
        {
          conversationId: input.conversationId,
          providerId: input.providerId,
        }
      );
    }

    let hook;
    try {
      hook = await this.hookServer.ensureStarted();
    } catch (error) {
      this.deps.logger.warn('TuiAgentsRuntime: hook server unavailable; spawning without hooks', {
        conversationId: input.conversationId,
        providerId: input.providerId,
        error: String(error),
      });
      return {};
    }

    return {
      EMDASH_HOOK_PORT: String(hook.port),
      EMDASH_PTY_ID: input.conversationId,
      EMDASH_HOOK_NONCE: hook.token,
      EMDASH_HOOK_TOKEN: hook.token,
    };
  }

  private syncSessionState(state: TuiSessionState): void {
    const activity = this.lifecycle.activity(state.conversationId);
    const next: TuiSessionState = { ...state };
    if (activity.lastInputAt !== null) {
      next.lastInputAt = activity.lastInputAt;
    }
    if (activity.lastOutputAt !== null) {
      next.lastOutputAt = activity.lastOutputAt;
    }
    produceCell(this.sessionsList.states.list, (draft) => {
      draft[state.conversationId] = next;
    });
  }

  private syncSessionActivity(conversationId: string, activity: ActivityFields): void {
    produceCell(this.sessionsList.states.list, (draft) => {
      const current = draft[conversationId];
      if (!current) return;
      if (activity.lastInputAt !== null) current.lastInputAt = activity.lastInputAt;
      if (activity.lastOutputAt !== null) current.lastOutputAt = activity.lastOutputAt;
    });
  }

  private lifecycleSnapshot(
    conversationId: string,
    activity: ActivityFields
  ): SessionSnapshotJudgment | null {
    const config = this.configs.get(conversationId);
    if (!config || config.intent === 'stopped') return null;
    const state = peek(this.sessionsList.states.list)[conversationId];
    const now = this.clock.now();
    const tmuxLastOutputAt = config.input.tmuxSessionName
      ? this.tmuxActivity.get(config.input.tmuxSessionName)
      : undefined;
    const lastOutputAt = maxNullable(activity.lastOutputAt, tmuxLastOutputAt);
    // Interactive busy window, plus tmux-side liveness: recent output inside the
    // tmux session must keep the key alive exactly as long as the idle policy's
    // output window would (it previously enriched the policy's lastOutputAt).
    const busy =
      (lastOutputAt !== null && now - lastOutputAt < BUSY_OUTPUT_WINDOW_MS) ||
      (tmuxLastOutputAt !== undefined && now - tmuxLastOutputAt < this.tmuxKeepAliveMs) ||
      this.detachedZellijSessionAlive(conversationId, config);
    return { running: state?.status === 'running', busy };
  }

  /**
   * Lists zellij only when a zellij-backed conversation has lost its PTY client;
   * attached sessions are judged by PTY activity like everything else.
   */
  private async refreshDetachedZellijLiveness(): Promise<void> {
    const detached = [...this.configs.entries()].some(
      ([conversationId, config]) =>
        config.input.zellijSessionName !== undefined &&
        config.intent !== 'stopped' &&
        !this.sessions.get(conversationId)?.pty
    );
    if (!detached) {
      this.zellijSessions = new Map();
      this.zellijListingFailed = false;
      return;
    }
    try {
      this.zellijSessions = await listZellijSessions(this.deps.exec);
      this.zellijListingFailed = false;
    } catch (error) {
      this.zellijListingFailed = true;
      this.deps.logger.warn('TuiAgentsRuntime: zellij listing failed; keeping detached sessions', {
        error: String(error),
      });
    }
  }

  private detachedZellijSessionAlive(conversationId: string, config: TuiSessionConfig): boolean {
    const sessionName = config.input.zellijSessionName;
    if (!sessionName || this.sessions.get(conversationId)?.pty) return false;
    return (
      this.zellijListingFailed ||
      activeZellijSessionFor(this.zellijSessions, sessionName) !== undefined
    );
  }

  private setResumeState(
    conversationId: string,
    resume: NonNullable<TuiSessionState['resume']>
  ): void {
    produceCell(this.sessionsList.states.list, (draft) => {
      const current = draft[conversationId];
      if (current) {
        current.resume = resume;
        return;
      }
      const config = this.configs.get(conversationId);
      if (!config) return;
      draft[conversationId] = {
        conversationId,
        providerId: config.input.providerId,
        cwd: config.input.cwd,
        sessionId: config.input.sessionId,
        status: 'exited',
        cols: config.input.cols,
        rows: config.input.rows,
        resume,
        startedAt: this.clock.now(),
      };
    });
  }

  private markExited(conversationId: string, info: PtyExitInfo | null): void {
    produceCell(this.sessionsList.states.list, (draft) => {
      const current = draft[conversationId];
      if (!current) return;
      current.status = 'exited';
      current.exit = info
        ? { exitCode: info.exitCode, signal: info.signal ?? undefined }
        : undefined;
    });
  }

  private updateSessionSize(conversationId: string, cols: number, rows: number): void {
    produceCell(this.sessionsList.states.list, (draft) => {
      const current = draft[conversationId];
      if (!current) return;
      current.cols = cols;
      current.rows = rows;
    });
  }

  private currentProviderSessionId(conversationId: string, fallback: string | null): string | null {
    return peek(this.sessionsList.states.list)[conversationId]?.sessionId ?? fallback;
  }

  private currentResumeState(conversationId: string): TuiSessionState['resume'] {
    return peek(this.sessionsList.states.list)[conversationId]?.resume ?? null;
  }

  private async spawnSpec(
    command: AgentCommand,
    input: TuiAgentStartInput,
    env: Record<string, string>
  ): Promise<Pick<PtySpawnSpec, 'invocation'>> {
    const platform = this.deps.platform ?? process.platform;
    const shellProfile = await resolveTerminalShell({
      intent: 'system',
      platform,
      env: await this.deps.env(),
    });
    const resolved = resolveLocalPtySpawn({
      intent: {
        kind: 'run-command',
        cwd: input.cwd,
        command: { kind: 'argv', command: command.command, args: command.args },
        shellSetup: input.shellSetup,
        shellProfile,
        tmuxSessionName: input.tmuxSessionName,
        zellijSessionName: input.zellijSessionName,
      },
      platform,
      env,
    });
    logLocalPtySpawnWarnings(
      'TuiAgentsRuntime',
      resolved.warnings,
      { conversationId: input.conversationId },
      this.deps.logger
    );
    return { invocation: resolved.invocation };
  }

  private maybeRespawnAfterUnexpectedExit(
    session: TuiAgentSession,
    config: TuiSessionConfig,
    generation: number,
    info: PtyExitInfo
  ): boolean {
    if (hasMultiplexerSession(config.input) || config.intent === 'stopped') return false;
    if (!this.isUnexpectedExit(info)) return false;
    const current = this.configs.get(config.input.conversationId);
    if (!current || current.intent === 'stopped') return false;

    const attempts = this.unexpectedRespawns.get(config.input.conversationId) ?? 0;
    if (attempts >= MAX_UNEXPECTED_RESPAWNS) return false;
    this.unexpectedRespawns.set(config.input.conversationId, attempts + 1);
    setTimeout(() => {
      if (!this.isCurrentGeneration(config.input.conversationId, generation)) return;
      const active = this.sessions.get(config.input.conversationId);
      const latest = this.configs.get(config.input.conversationId);
      if (!active || active !== session || active.pty || !latest || latest.intent === 'stopped') {
        return;
      }
      void this.launchCurrentConfig(config.input.conversationId);
    }, RESPAWN_DELAY_MS);
    return true;
  }

  private isUnexpectedExit(info: PtyExitInfo): boolean {
    return info.exitCode !== 0 || info.signal !== null;
  }

  /**
   * Reconcile liveness: the multiplexer session must exist and, for zellij,
   * be running. zellij matches by id hash so a session created under an
   * earlier task label still counts.
   */
  private multiplexerSessionAlive(input: TuiAgentStartInput): boolean {
    if (input.tmuxSessionName) return this.tmuxActivity.has(input.tmuxSessionName);
    if (input.zellijSessionName) {
      return activeZellijSessionFor(this.zellijSessions, input.zellijSessionName) !== undefined;
    }
    return false;
  }

  private async killMultiplexerForConfig(config: TuiSessionConfig | undefined): Promise<void> {
    if ((this.deps.platform ?? process.platform) === 'win32') return;
    const tmuxSessionName = config?.input.tmuxSessionName;
    if (tmuxSessionName) {
      await killTmuxSession(this.deps.exec, tmuxSessionName, (error) => {
        this.deps.logger.debug('TuiAgentsRuntime: tmux session not found or already stopped', {
          sessionName: tmuxSessionName,
          error: String(error),
        });
      });
      return;
    }
    const zellijSessionName = config?.input.zellijSessionName;
    if (!zellijSessionName) return;
    await killZellijSessionsMatching(this.deps.exec, zellijSessionName, (error) => {
      this.deps.logger.debug('TuiAgentsRuntime: zellij session not found or already stopped', {
        sessionName: zellijSessionName,
        error: String(error),
      });
    });
  }

  private normalizePlatformInput<T extends TuiAgentStartInput>(input: T): T {
    if ((this.deps.platform ?? process.platform) !== 'win32' || !hasMultiplexerSession(input)) {
      return input;
    }
    const {
      tmuxSessionName: _tmuxSessionName,
      zellijSessionName: _zellijSessionName,
      ...normalized
    } = input;
    return normalized as T;
  }
}

/** Only active intents are resumed, so only they decide which multiplexers reconcile consults. */
function intentUsesZellij(intent: SessionIntent): boolean {
  return activeIntentHasStringField(intent, 'zellijSessionName');
}

function intentUsesTmux(intent: SessionIntent): boolean {
  return activeIntentHasStringField(intent, 'tmuxSessionName');
}

function activeIntentHasStringField(intent: SessionIntent, field: string): boolean {
  if (intent.status !== 'active') return false;
  const payload: unknown = intent.payload;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as Record<string, unknown>)[field] === 'string'
  );
}

function hasMultiplexerSession(
  input: Pick<TuiAgentStartInput, 'tmuxSessionName' | 'zellijSessionName'>
): boolean {
  return Boolean(input.tmuxSessionName || input.zellijSessionName);
}

function maxNullable(a: number | null, b: number | null | undefined): number | null {
  if (a === null) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}
