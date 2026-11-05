import {
  BridgeError,
  PLATFORM_LABELS,
  PLATFORMS,
  type AppConfig,
  type ConnectionState,
  type MessageRule,
  type OneBotEvent,
  type Platform,
  type PlatformCapabilities,
  type PlatformSettingsView,
  type PlatformView,
  type ReplyPolicyConfig,
  type RetryPolicyConfig,
  type RulesEngineConfig,
  type SettingsView,
  type UnifiedMessageEvent,
  segmentsToPlainText,
} from '@omni-relay/shared-types';
import { checkDeliveryCapability, resolveCapabilities } from '@omni-relay/capabilities';
import {
  createBridgeMessageId,
  createEventId,
  discordDedupeKey,
  qqDedupeKey,
  segmentTypeList,
  summarizeSegments,
  truncate,
  unifiedToOneBotEvent,
} from '@omni-relay/core';
import { evaluateMessageRule } from '@omni-relay/rules';
import {
  createDeliveryPlanner,
  createOutboxWorker,
  type DeliveryPlanner,
  type OutboxSender,
  type OutboxWorker,
} from '@omni-relay/queue';
import {
  createActionRegistry,
  createOneBotServer,
  type ActionRegistry,
  type OneBotServer,
} from '@omni-relay/onebot';
import {
  DiscordAdapter,
  DiscordGateway,
  DiscordRestClient,
  computeIntents,
  type DiscordSocketLike,
} from '@omni-relay/adapters-discord';
import {
  QQ_INTENT_GROUP_AND_C2C_EVENT,
  QqAdapter,
  QqGateway,
  QqRestClient,
  QqTokenManager,
  type QqSocketFactory,
} from '@omni-relay/adapters-qq';
import type { Storage } from '@omni-relay/storage';

import type { AppLogger } from './logger.js';
import { APP_VERSION, DEFAULT_SELF_ID, ONEBOT_NICKNAME } from './version.js';

export interface PlatformConnection {
  platform: Platform;
  enabled: boolean;
  configured: boolean;
  connection: ConnectionState;
  detail: string | null;
  lastEventAt: string | null;
}

export interface RuntimeStatusSnapshot {
  startedAt: string;
  uptimeSeconds: number;
  onebot: {
    connected: boolean;
    clients: number;
    lastEventAt: string | null;
    pendingActions: number;
  };
  platforms: PlatformConnection[];
}

interface DiscordBundle {
  rest: DiscordRestClient;
  gateway: DiscordGateway;
  adapter: DiscordAdapter;
}

interface QqBundle {
  tokenManager: QqTokenManager;
  rest: QqRestClient;
  gateway: QqGateway;
  adapter: QqAdapter;
}

export interface BridgeRuntimeOptions {
  config: AppConfig;
  storage: Storage;
  logger: AppLogger;
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => Date) | undefined;
  /**
   * Test seam: lets the integration suite replace the network layer while the
   * production wiring (storage, rules, queue, OneBot server) stays untouched.
   */
  transport?: RuntimeTransport | undefined;
}

export interface RuntimeTransport {
  fetchImpl?: typeof fetch | undefined;
  createSocket?: ((url: string) => DiscordSocketLike) | undefined;
}

const SETTINGS_KEYS = {
  platformEnabled: (platform: Platform) => `platform.${platform}.enabled`,
  platformSettings: (platform: Platform) => `platform.${platform}.settings`,
  replyPolicy: 'reply_policy',
  rulesEngine: 'rules.engine',
  retry: 'retry',
  onebotSelfId: 'onebot.self_id',
} as const;

/** Per-platform safety limit for OneBot-initiated sends (60 messages/minute). */
const ACTION_RATE_LIMIT = { maxMessages: 60, windowSeconds: 60 } as const;

/**
 * The bridge runtime owns every long-lived component: storage, adapters,
 * gateways, the OneBot server and the outbox worker. The HTTP layer only reads
 * this object.
 */
export class BridgeRuntime {
  readonly config: AppConfig;
  readonly storage: Storage;
  readonly logger: AppLogger;
  readonly onebot: OneBotServer;
  readonly registry: ActionRegistry;

  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly transport: RuntimeTransport;
  private discord: DiscordBundle | null = null;
  private qq: QqBundle | null = null;
  private worker: OutboxWorker;
  private readonly planners = new Map<Platform, DeliveryPlanner>();
  private readonly lastInbound = new Map<
    string,
    { nativeMessageId: string; receivedAt: number; expiresAt: string | null }
  >();
  private readonly startedAtDate: Date;
  private rulesCache: { rules: MessageRule[]; loadedAt: number } | null = null;
  private started = false;
  private onebotAddress: { host: string; port: number } | null = null;

  constructor(options: BridgeRuntimeOptions) {
    this.config = options.config;
    this.storage = options.storage;
    this.logger = options.logger;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.transport = options.transport ?? {};
    this.startedAtDate = this.now();

    this.registry = createActionRegistry(this.logger);
    this.onebot = createOneBotServer({
      host: this.config.server.host,
      port: this.config.server.onebotPort,
      websocketPath: this.config.server.websocketPath,
      accessToken: this.resolveAccessToken(),
      actionTimeoutMs: this.config.onebot.actionTimeoutMs,
      maxPendingActions: this.config.onebot.maxPendingActions,
      heartbeatIntervalSeconds: this.config.onebot.heartbeatIntervalSeconds,
      registry: this.registry,
      getSelfId: () => this.getSelfId(),
      appVersion: APP_VERSION,
      logger: this.logger,
    });

    this.initPlanners();
    this.worker = createOutboxWorker({
      storage: this.storage,
      resolveSender: (platform) => this.resolveSender(platform),
      retryPolicy: this.getRetryPolicy(),
      logger: this.logger,
      now: this.now,
      batchSize: 10,
      pollIntervalMs: 1_000,
    });
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.initDiscord();
    this.initQq();
    this.invalidateRules();

    const address = await this.onebot.start();
    this.onebotAddress = { host: address.host, port: address.port };
    this.logger.info('onebot reverse websocket listening', {
      event: 'onebot.listen',
      host: address.host,
      port: address.port,
      path: this.config.server.websocketPath,
    });

    this.worker.start();
    await this.applyPlatformEnabledState();
    this.started = true;
    this.logger.info('omni-relay runtime started', {
      event: 'runtime.start',
      version: APP_VERSION,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    await this.worker.stop();
    await this.discord?.gateway.close();
    await this.qq?.gateway.close();
    await this.onebot.close();
    this.logger.info('omni-relay runtime stopped', { event: 'runtime.stop' });
  }

  private resolveAccessToken(): string | null {
    const envName = this.config.onebot.accessTokenEnv;
    const token = this.env[envName];
    if (!token) {
      if (this.config.onebot.requireAccessToken) {
        throw new BridgeError({
          code: 'invalid_config',
          message: `Environment variable ${envName} is required by onebot.require_access_token but is not set`,
          retryable: false,
        });
      }
      return null;
    }
    return token;
  }

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  /** True once the OneBot listener and the outbox worker are running. */
  isReady(): boolean {
    return this.started;
  }

  /** Actual bound OneBot listener address (useful when configured with port 0). */
  getOneBotAddress(): { host: string; port: number } | null {
    return this.onebotAddress;
  }

  getStatus(): RuntimeStatusSnapshot {
    return {
      startedAt: this.startedAtDate.toISOString(),
      uptimeSeconds: Math.max(
        0,
        Math.round((this.now().getTime() - this.startedAtDate.getTime()) / 1000),
      ),
      onebot: this.onebot.getStatus(),
      platforms: PLATFORMS.map((platform) => this.getPlatformConnection(platform)),
    };
  }

  getPlatformConnection(platform: Platform): PlatformConnection {
    const enabled = this.isPlatformEnabled(platform);
    const bundle = this.getBundle(platform);
    const configured = bundle !== null;
    if (!enabled) {
      return {
        platform,
        enabled,
        configured,
        connection: 'disabled',
        detail: null,
        lastEventAt: bundle?.adapter.getLastEventAt() ?? null,
      };
    }
    if (!bundle) {
      return {
        platform,
        enabled,
        configured,
        connection: 'unconfigured',
        detail: this.missingCredentialsHint(platform),
        lastEventAt: null,
      };
    }
    const status = bundle.adapter.getStatus();
    const state = 'state' in status ? status.state : 'disconnected';
    const connection: ConnectionState =
      state === 'connected'
        ? 'connected'
        : state === 'connecting'
          ? 'connecting'
          : state === 'reconnecting'
            ? 'reconnecting'
            : state === 'error'
              ? 'error'
              : 'disconnected';
    return {
      platform,
      enabled,
      configured,
      connection,
      detail: 'lastError' in status ? status.lastError : null,
      lastEventAt: bundle.adapter.getLastEventAt() ?? null,
    };
  }

  getCapabilities(platform: Platform): PlatformCapabilities {
    return resolveCapabilities(platform, this.config.capabilities);
  }

  // -------------------------------------------------------------------------
  // platform management
  // -------------------------------------------------------------------------

  isPlatformEnabled(platform: Platform): boolean {
    const stored = this.storage.settings.get<boolean>(SETTINGS_KEYS.platformEnabled(platform));
    if (typeof stored === 'boolean') {
      return stored;
    }
    return platform === 'discord' ? this.config.discord.enabled : this.config.qq.enabled;
  }

  getPlatformSettingsView(platform: Platform): PlatformSettingsView {
    const stored =
      this.storage.settings.get<Partial<PlatformSettingsView>>(
        SETTINGS_KEYS.platformSettings(platform),
      ) ?? {};
    const defaults: PlatformSettingsView = {
      guildAllowlist: platform === 'discord' ? [...this.config.discord.guildAllowlist] : [],
      channelAllowlist: platform === 'discord' ? [...this.config.discord.channelAllowlist] : [],
      groupAllowlist: platform === 'qq-official' ? [...this.config.qq.groupAllowlist] : [],
      allowProactivePrivate:
        platform === 'qq-official' ? this.config.qq.allowProactivePrivate : false,
      allowProactiveGroup: platform === 'qq-official' ? this.config.qq.allowProactiveGroup : false,
      receiveAllGroupMessages:
        platform === 'qq-official' ? this.config.qq.receiveAllGroupMessages : false,
      messageContentIntent:
        platform === 'discord' ? this.config.discord.intents.messageContent : false,
    };
    return { ...defaults, ...stored };
  }

  getPlatformView(platform: Platform): PlatformView {
    const connection = this.getPlatformConnection(platform);
    return {
      platform,
      label: PLATFORM_LABELS[platform],
      enabled: connection.enabled,
      connection: connection.connection,
      detail: connection.detail,
      lastEventAt: connection.lastEventAt,
      credentials: this.getCredentialViews(platform),
      capabilities: this.getCapabilities(platform),
      settings: this.getPlatformSettingsView(platform),
    };
  }

  async setPlatformEnabled(platform: Platform, enabled: boolean): Promise<void> {
    this.storage.settings.set(SETTINGS_KEYS.platformEnabled(platform), enabled);
    await this.applyPlatformEnabledState(platform);
  }

  async updatePlatformSettings(
    platform: Platform,
    patch: Partial<PlatformSettingsView>,
  ): Promise<PlatformView> {
    const current = this.getPlatformSettingsView(platform);
    const next: PlatformSettingsView = {
      guildAllowlist: sanitizeIdList(patch.guildAllowlist ?? current.guildAllowlist),
      channelAllowlist: sanitizeIdList(patch.channelAllowlist ?? current.channelAllowlist),
      groupAllowlist: sanitizeIdList(patch.groupAllowlist ?? current.groupAllowlist),
      allowProactivePrivate: patch.allowProactivePrivate ?? current.allowProactivePrivate,
      allowProactiveGroup: patch.allowProactiveGroup ?? current.allowProactiveGroup,
      receiveAllGroupMessages: patch.receiveAllGroupMessages ?? current.receiveAllGroupMessages,
      messageContentIntent: patch.messageContentIntent ?? current.messageContentIntent,
    };
    this.storage.settings.set(SETTINGS_KEYS.platformSettings(platform), next);
    this.applySettingsToAdapter(platform, next);
    return this.getPlatformView(platform);
  }

  async testPlatform(platform: Platform): Promise<{ ok: boolean; message: string }> {
    const bundle = this.getBundle(platform);
    if (!bundle) {
      return { ok: false, message: this.missingCredentialsHint(platform) };
    }
    try {
      if (platform === 'discord' && this.discord) {
        const user = await this.discord.rest.getCurrentUser();
        this.discord.adapter.setBotUserId(user.id);
        return {
          ok: true,
          message: `Discord 凭据有效，机器人：${user.username ?? user.id}`,
        };
      }
      if (platform === 'qq-official' && this.qq) {
        await this.qq.tokenManager.refresh();
        const gatewayUrl = await this.qq.rest.getGatewayUrl();
        return {
          ok: true,
          message: `QQ 鉴权成功，Gateway：${gatewayUrl}`,
        };
      }
      return { ok: false, message: '平台未初始化' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('platform test failed', {
        event: 'platform.test',
        platform,
        error: message,
      });
      return { ok: false, message: `连接测试失败：${message}` };
    }
  }

  async reconnectPlatform(platform: Platform): Promise<{ ok: boolean; message: string }> {
    if (!this.isPlatformEnabled(platform)) {
      return { ok: false, message: '平台已停用，请先启用' };
    }
    const bundle = this.getBundle(platform);
    if (!bundle) {
      return { ok: false, message: this.missingCredentialsHint(platform) };
    }
    try {
      await bundle.gateway.close();
      bundle.gateway.connect();
      return { ok: true, message: '已触发重连' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `重连失败：${message}` };
    }
  }

  private async applyPlatformEnabledState(only?: Platform): Promise<void> {
    const platforms = only ? [only] : PLATFORMS;
    for (const platform of platforms) {
      const enabled = this.isPlatformEnabled(platform);
      const bundle = this.getBundle(platform);
      if (!bundle) {
        if (enabled) {
          this.logger.warn('platform enabled without credentials', {
            event: 'platform.unconfigured',
            platform,
            hint: this.missingCredentialsHint(platform),
          });
        }
        continue;
      }
      const state =
        'state' in bundle.adapter.getStatus() ? bundle.adapter.getStatus().state : 'disconnected';
      if (enabled && state === 'disconnected') {
        bundle.gateway.connect();
        this.logger.info('platform connecting', { event: 'platform.connect', platform });
      }
      if (!enabled && state !== 'disconnected') {
        await bundle.gateway.close();
        this.logger.info('platform disconnected', { event: 'platform.disconnect', platform });
      }
    }
  }

  private applySettingsToAdapter(platform: Platform, settings: PlatformSettingsView): void {
    const bundle = this.getBundle(platform);
    if (!bundle) {
      return;
    }
    bundle.adapter.applySettings?.(settings);
  }

  private getBundle(platform: Platform): DiscordBundle | QqBundle | null {
    return platform === 'discord' ? this.discord : this.qq;
  }

  private missingCredentialsHint(platform: Platform): string {
    if (platform === 'discord') {
      return `缺少环境变量 ${this.config.discord.tokenEnv}（Discord Bot Token）`;
    }
    return `缺少环境变量 ${this.config.qq.appIdEnv} / ${this.config.qq.appSecretEnv}（QQ AppID / AppSecret）`;
  }

  private getCredentialViews(platform: Platform) {
    if (platform === 'discord') {
      return [
        {
          name: 'Bot Token',
          env: this.config.discord.tokenEnv,
          state: (this.env[this.config.discord.tokenEnv] ? 'configured' : 'missing') as
            'configured' | 'missing',
        },
      ];
    }
    return [
      {
        name: 'AppID',
        env: this.config.qq.appIdEnv,
        state: (this.env[this.config.qq.appIdEnv] ? 'configured' : 'missing') as
          'configured' | 'missing',
      },
      {
        name: 'AppSecret',
        env: this.config.qq.appSecretEnv,
        state: (this.env[this.config.qq.appSecretEnv] ? 'configured' : 'missing') as
          'configured' | 'missing',
      },
    ];
  }

  // -------------------------------------------------------------------------
  // adapter construction
  // -------------------------------------------------------------------------

  private initDiscord(): void {
    const token = this.env[this.config.discord.tokenEnv];
    if (!token) {
      this.logger.warn('discord adapter not configured', {
        event: 'adapter.discord.unconfigured',
        env: this.config.discord.tokenEnv,
      });
      return;
    }
    const rest = new DiscordRestClient({
      token,
      apiBaseUrl: this.config.discord.apiBaseUrl,
      timeoutMs: this.config.discord.restTimeoutMs,
      ...(this.transport.fetchImpl ? { fetchImpl: this.transport.fetchImpl } : {}),
    });
    const gateway = new DiscordGateway({
      token,
      gatewayUrl: this.config.discord.gatewayUrl,
      intents: computeIntents(this.config.discord.intents),
      logger: this.logger,
      ...(this.transport.createSocket ? { createSocket: this.transport.createSocket } : {}),
      onDispatch: (name, data) => {
        if (name !== 'MESSAGE_CREATE') {
          return;
        }
        const event = this.discord?.adapter.handleDispatch(name, data) ?? null;
        if (event) {
          this.handleInbound(event);
        }
      },
      onReady: (user) => {
        this.discord?.adapter.setBotUserId(user.id);
        this.logger.info('discord ready', { event: 'adapter.discord.ready', botId: user.id });
      },
    });
    const adapter = new DiscordAdapter({
      rest,
      gateway,
      guildAllowlist: this.config.discord.guildAllowlist,
      channelAllowlist: this.config.discord.channelAllowlist,
      logger: this.logger,
      ...(this.transport.fetchImpl ? { fetchImpl: this.transport.fetchImpl } : {}),
    });
    this.discord = { rest, gateway, adapter };
  }

  private initQq(): void {
    const appId = this.env[this.config.qq.appIdEnv];
    const appSecret = this.env[this.config.qq.appSecretEnv];
    if (!appId || !appSecret) {
      this.logger.warn('qq adapter not configured', {
        event: 'adapter.qq.unconfigured',
        env: `${this.config.qq.appIdEnv}/${this.config.qq.appSecretEnv}`,
      });
      return;
    }
    const tokenManager = new QqTokenManager({
      appId,
      appSecret,
      tokenUrl: this.config.qq.tokenUrl,
      timeoutMs: this.config.qq.restTimeoutMs,
      logger: this.logger,
      ...(this.transport.fetchImpl ? { fetchImpl: this.transport.fetchImpl } : {}),
    });
    const rest = new QqRestClient({
      appId,
      tokenManager,
      apiBaseUrl: this.config.qq.apiBaseUrl,
      timeoutMs: this.config.qq.restTimeoutMs,
      ...(this.transport.fetchImpl ? { fetchImpl: this.transport.fetchImpl } : {}),
    });

    // The gateway URL is fetched lazily by QQ; the WebSocket handshake requires
    // it, so a placeholder is used until the first successful refresh.
    const gateway = new QqGateway({
      getAccessToken: () => tokenManager.getAccessToken(),
      gatewayUrl: 'wss://api.sgroup.qq.com/websocket',
      intents: QQ_INTENT_GROUP_AND_C2C_EVENT,
      logger: this.logger,
      ...(this.transport.createSocket
        ? { createSocket: this.transport.createSocket as unknown as QqSocketFactory }
        : {}),
      onDispatch: (name, data) => {
        const event = this.qq?.adapter.handleDispatch(name, data) ?? null;
        if (event) {
          this.handleInbound(event);
        }
      },
      onReady: () => {
        this.logger.info('qq gateway ready', { event: 'adapter.qq.ready' });
      },
    });
    const adapter = new QqAdapter({
      rest,
      gateway,
      groupAllowlist: this.config.qq.groupAllowlist,
      allowProactivePrivate: this.config.qq.allowProactivePrivate,
      allowProactiveGroup: this.config.qq.allowProactiveGroup,
      receiveAllGroupMessages: this.config.qq.receiveAllGroupMessages,
      passiveReplyWindowSeconds: this.config.qq.passiveReplyWindowSeconds,
      logger: this.logger,
    });
    this.qq = { tokenManager, rest, gateway, adapter };
  }

  // -------------------------------------------------------------------------
  // settings
  // -------------------------------------------------------------------------

  getReplyPolicy(): ReplyPolicyConfig {
    const stored = this.storage.settings.get<Partial<ReplyPolicyConfig>>(SETTINGS_KEYS.replyPolicy);
    return { ...this.config.replyPolicy, ...(stored ?? {}) };
  }

  getEngineConfig(): RulesEngineConfig {
    const stored = this.storage.settings.get<Partial<RulesEngineConfig>>(SETTINGS_KEYS.rulesEngine);
    return { ...this.config.rules, ...(stored ?? {}) };
  }

  getRetryPolicy(): RetryPolicyConfig {
    const stored = this.storage.settings.get<Partial<RetryPolicyConfig>>(SETTINGS_KEYS.retry);
    return { ...this.config.retry, ...(stored ?? {}) };
  }

  getSelfId(): number {
    const stored = this.storage.settings.get<number>(SETTINGS_KEYS.onebotSelfId);
    return typeof stored === 'number' ? stored : DEFAULT_SELF_ID;
  }

  getSettingsView(): SettingsView {
    return {
      version: APP_VERSION,
      nodeVersion: process.version,
      paths: {
        dataDir: this.config.server.dataDir,
        sqlitePath: this.config.storage.sqlitePath,
      },
      replyPolicy: this.getReplyPolicy(),
      rules: this.getEngineConfig(),
      retry: this.getRetryPolicy(),
      onebot: {
        websocketPath: this.config.server.websocketPath,
        accessTokenConfigured: Boolean(this.env[this.config.onebot.accessTokenEnv]),
        actionTimeoutMs: this.config.onebot.actionTimeoutMs,
        maxPendingActions: this.config.onebot.maxPendingActions,
      },
      web: {
        adminAuth: this.config.web.adminAuth,
        sessionTtlSeconds: this.config.web.sessionTtlSeconds,
      },
      logging: {
        level: this.config.logging.level,
        pretty: this.config.logging.pretty,
      },
    };
  }

  updateSettings(patch: {
    replyPolicy?: Partial<ReplyPolicyConfig> | undefined;
    rules?: Partial<RulesEngineConfig> | undefined;
    retry?: Partial<RetryPolicyConfig> | undefined;
  }): SettingsView {
    if (patch.replyPolicy) {
      this.storage.settings.set(SETTINGS_KEYS.replyPolicy, {
        ...this.getReplyPolicy(),
        ...patch.replyPolicy,
      });
    }
    if (patch.rules) {
      this.storage.settings.set(SETTINGS_KEYS.rulesEngine, {
        ...this.getEngineConfig(),
        ...patch.rules,
      });
    }
    if (patch.retry) {
      this.storage.settings.set(SETTINGS_KEYS.retry, {
        ...this.getRetryPolicy(),
        ...patch.retry,
      });
      this.restartWorker();
    }
    return this.getSettingsView();
  }

  private restartWorker(): void {
    const wasStarted = this.started;
    this.worker.stop().catch(() => undefined);
    this.worker = createOutboxWorker({
      storage: this.storage,
      resolveSender: (platform) => this.resolveSender(platform),
      retryPolicy: this.getRetryPolicy(),
      logger: this.logger,
      now: this.now,
      batchSize: 10,
      pollIntervalMs: 1_000,
    });
    if (wasStarted) {
      this.worker.start();
    }
  }

  // -------------------------------------------------------------------------
  // rules
  // -------------------------------------------------------------------------

  getRules(): MessageRule[] {
    if (this.rulesCache && this.now().getTime() - this.rulesCache.loadedAt < 5_000) {
      return this.rulesCache.rules;
    }
    const rules = this.storage.rules.list();
    this.rulesCache = { rules, loadedAt: this.now().getTime() };
    return rules;
  }

  invalidateRules(): void {
    this.rulesCache = null;
  }

  // -------------------------------------------------------------------------
  // outbound
  // -------------------------------------------------------------------------

  private initPlanners(): void {
    for (const platform of PLATFORMS) {
      this.planners.set(
        platform,
        createDeliveryPlanner({
          storage: this.storage,
          capabilities: this.getCapabilities(platform),
          logger: this.logger,
          now: this.now,
        }),
      );
    }
  }

  getPlanner(platform: Platform): DeliveryPlanner {
    const planner = this.planners.get(platform);
    if (!planner) {
      throw new BridgeError({ code: 'internal', message: 'planner_missing', retryable: false });
    }
    return planner;
  }

  resolveSender(platform: Platform): OutboxSender | null {
    if (!this.isPlatformEnabled(platform)) {
      return null;
    }
    const bundle = this.getBundle(platform);
    if (!bundle) {
      return null;
    }
    return bundle.adapter as unknown as OutboxSender;
  }

  /** Last inbound message per conversation, used to keep QQ replies passive. */
  getReplyTarget(
    platform: Platform,
    conversationNativeId: string,
  ): { nativeMessageId: string | null; expiresAt: string | null } {
    const key = `${platform}:${conversationNativeId}`;
    const entry = this.lastInbound.get(key);
    if (!entry) {
      return { nativeMessageId: null, expiresAt: null };
    }
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= this.now().getTime()) {
      return { nativeMessageId: null, expiresAt: null };
    }
    return { nativeMessageId: entry.nativeMessageId, expiresAt: entry.expiresAt };
  }

  /** Runs one outbox batch immediately; used by tests and manual operations. */
  async processQueueOnce(): Promise<{
    claimed: number;
    sent: number;
    retried: number;
    dead: number;
  }> {
    return this.worker.tick();
  }

  getActionRateLimit(): { maxMessages: number; windowSeconds: number } {
    return { ...ACTION_RATE_LIMIT };
  }

  // -------------------------------------------------------------------------
  // inbound pipeline
  // -------------------------------------------------------------------------

  /**
   * Inbound pipeline: dedupe -> identity mapping -> platform policy -> rule
   * engine -> OneBot event forwarding. Order follows the specification.
   */
  handleInbound(event: UnifiedMessageEvent): void {
    const dedupeKey = this.dedupeKeyFor(event);
    const isNew = this.storage.dedupe.markSeen(dedupeKey, {
      ttlSeconds: this.config.storage.dedupeTtlSeconds,
      now: this.now(),
    });
    if (!isNew) {
      this.logger.debug('duplicate inbound message dropped', {
        event: 'inbound.duplicate',
        platform: event.platform,
        dedupeKey,
      });
      return;
    }

    const conversationMapping = this.storage.ids.getOrCreate({
      platform: event.platform,
      nativeKind: this.conversationNativeKind(event),
      nativeId: event.conversation.nativeId,
      displayName: event.conversation.displayName,
    });
    const senderMapping = this.storage.ids.getOrCreate({
      platform: event.platform,
      nativeKind: 'user',
      nativeId: event.sender.nativeId,
      displayName: event.sender.displayName ?? event.sender.username,
    });

    this.rememberInbound(event);

    const capabilities = this.getCapabilities(event.platform);
    const evaluation = evaluateMessageRule(event, this.getRules(), capabilities, {
      replyPolicy: this.getReplyPolicy(),
      engine: this.getEngineConfig(),
      now: this.now(),
    });

    const text = truncate(segmentsToPlainText(event.message), 2_000);
    const baseRecord = {
      bridgeMessageId: event.meta.bridgeMessageId,
      platform: event.platform,
      conversationKind: event.conversation.kind,
      conversationNativeId: event.conversation.nativeId,
      conversationDisplayName: event.conversation.displayName ?? null,
      senderNativeId: event.sender.nativeId,
      senderDisplayName: event.sender.displayName ?? event.sender.username ?? null,
      onebotUserId: senderMapping.onebotId,
      onebotGroupId: conversationMapping.onebotId,
      segments: event.message,
      text,
      matchedRuleId: evaluation.matchedRules[0] ?? null,
      nativeMessageId: event.meta.nativeMessageId ?? null,
      createdAt: this.now(),
    };

    if (evaluation.decision !== 'reply') {
      this.storage.messages.record({
        ...baseRecord,
        status: evaluation.status,
        reason: evaluation.reason,
      });
      this.logger.info('inbound message ignored', {
        event: 'inbound.ignored',
        platform: event.platform,
        reason: evaluation.reason,
        conversation: event.conversation.nativeId,
      });
      return;
    }

    const onebotEvent = this.buildOneBotEvent(
      event,
      senderMapping.onebotId,
      conversationMapping.onebotId,
    );
    const delivered = this.onebot.broadcastEvent(onebotEvent);
    const status = delivered > 0 ? 'sent' : 'queued';
    const reason = delivered > 0 ? evaluation.reason : `${evaluation.reason};no_onebot_client`;

    this.storage.messages.record({ ...baseRecord, status, reason });

    this.logger.info('inbound message forwarded to onebot', {
      event: 'inbound.forwarded',
      platform: event.platform,
      clients: delivered,
      conversation: event.conversation.nativeId,
      rule: evaluation.matchedRules[0] ?? null,
      preview: summarizeSegments(event.message, 120),
      types: segmentTypeList(event.message),
    });
  }

  private buildOneBotEvent(
    event: UnifiedMessageEvent,
    onebotUserId: number,
    onebotGroupId: number,
  ): OneBotEvent {
    return unifiedToOneBotEvent(event, {
      selfId: this.getSelfId(),
      userId: onebotUserId,
      groupId: event.conversation.kind === 'private' ? null : onebotGroupId,
      resolveMentionUserId: (nativeUserId) => {
        const mapping = this.storage.ids.getOrCreate({
          platform: event.platform,
          nativeKind: 'user',
          nativeId: nativeUserId,
        });
        return mapping.onebotId;
      },
    });
  }

  private rememberInbound(event: UnifiedMessageEvent): void {
    const key = `${event.platform}:${event.conversation.nativeId}`;
    const nativeMessageId = event.meta.nativeMessageId;
    if (!nativeMessageId) {
      return;
    }
    this.lastInbound.set(key, {
      nativeMessageId,
      receivedAt: this.now().getTime(),
      expiresAt: event.replyContext?.expiresAt ?? null,
    });
    if (this.lastInbound.size > 5_000) {
      const oldest = [...this.lastInbound.entries()].sort(
        (a, b) => a[1].receivedAt - b[1].receivedAt,
      )[0];
      if (oldest) {
        this.lastInbound.delete(oldest[0]);
      }
    }
  }

  private dedupeKeyFor(event: UnifiedMessageEvent): string {
    const nativeMessageId = event.meta.nativeMessageId ?? event.eventId;
    if (event.platform === 'discord') {
      return discordDedupeKey(nativeMessageId);
    }
    return qqDedupeKey(nativeMessageId, event.meta.bridgeMessageId.slice(-8));
  }

  private conversationNativeKind(event: UnifiedMessageEvent): 'user' | 'group' | 'channel' {
    if (event.conversation.kind === 'private') {
      return 'user';
    }
    return event.platform === 'discord' ? 'channel' : 'group';
  }

  /** Guard used by the OneBot action layer before anything is queued. */
  assertDeliveryAllowed(
    platform: Platform,
    conversationKind: 'private' | 'group' | 'channel',
    proactive: boolean,
  ): void {
    const capabilities = this.getCapabilities(platform);
    const check = checkDeliveryCapability(capabilities, { conversationKind, proactive });
    if (!check.allowed) {
      throw new BridgeError({
        code: 'capability_unsupported',
        message: check.reason ?? 'capability_unsupported',
        retryable: false,
      });
    }
  }

  /** Native id kind used for a group/channel conversation on a given platform. */
  conversationNativeKindOf(platform: Platform): 'group' | 'channel' {
    return platform === 'discord' ? 'channel' : 'group';
  }

  getLogger(): AppLogger {
    return this.logger;
  }

  /**
   * Deletes a message on the origin platform.
   *
   * Only Discord exposes a recall API; QQ official bots have no delete endpoint,
   * so the capability is reported as unsupported instead of silently pretending
   * the message was removed.
   */
  async deletePlatformMessage(
    platform: Platform,
    conversationNativeId: string,
    nativeMessageId: string,
  ): Promise<void> {
    if (!this.isPlatformEnabled(platform)) {
      throw new BridgeError({
        code: 'platform_unavailable',
        message: `platform_disabled:${platform}`,
        retryable: false,
      });
    }
    if (platform === 'qq-official') {
      throw new BridgeError({
        code: 'capability_unsupported',
        message: 'qq_official_has_no_message_recall_api',
        retryable: false,
      });
    }
    const bundle = this.discord;
    if (!bundle) {
      throw new BridgeError({
        code: 'platform_unavailable',
        message: this.missingCredentialsHint('discord'),
        retryable: false,
      });
    }
    await bundle.rest.deleteMessage(conversationNativeId, nativeMessageId);
    this.logger.info('message deleted on platform', {
      event: 'platform.delete',
      platform,
      conversation: conversationNativeId,
    });
  }

  newActionEventId(): string {
    return createEventId('action');
  }

  newBridgeMessageId(platform: Platform): string {
    return createBridgeMessageId(platform);
  }

  getOneBotNickname(): string {
    return ONEBOT_NICKNAME;
  }
}

function sanitizeIdList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
