import type { PlatformCapabilities } from './platform.js';
import type { ReplyPolicyConfig, RulesEngineConfig } from './rules.js';
import type { RetryPolicyConfig } from './delivery.js';
import type { Platform } from './platform.js';

/** Parsed, camelCase runtime configuration (see config.example.yaml). */
export interface AppConfig {
  server: ServerConfig;
  web: WebConfig;
  replyPolicy: ReplyPolicyConfig;
  rules: RulesEngineConfig;
  onebot: OneBotConfig;
  discord: DiscordConfig;
  qq: QqConfig;
  storage: StorageConfig;
  retry: RetryPolicyConfig;
  logging: LoggingConfig;
  /** Optional capability overrides, merged over the conservative defaults. */
  capabilities: Partial<Record<Platform, Partial<PlatformCapabilities>>>;
}

export interface ServerConfig {
  host: string;
  onebotPort: number;
  healthPort: number;
  websocketPath: string;
  /** Directory used for the SQLite database and transient media cache. */
  dataDir: string;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
  adminAuth: boolean;
  sessionSecretEnv: string;
  adminPasswordHashEnv: string;
  corsOrigins: string[];
  /** Built SPA directory, resolved relative to the repository root. */
  staticDir: string;
  sessionTtlSeconds: number;
}

export interface OneBotConfig {
  accessTokenEnv: string;
  actionTimeoutMs: number;
  maxPendingActions: number;
  heartbeatIntervalSeconds: number;
  /** Refuse to start without an access token when true. */
  requireAccessToken: boolean;
}

export interface DiscordConfig {
  enabled: boolean;
  tokenEnv: string;
  guildAllowlist: string[];
  channelAllowlist: string[];
  intents: {
    guilds: boolean;
    guildMessages: boolean;
    messageContent: boolean;
    directMessages: boolean;
  };
  apiBaseUrl: string;
  gatewayUrl: string;
  restTimeoutMs: number;
}

export interface QqConfig {
  enabled: boolean;
  appIdEnv: string;
  appSecretEnv: string;
  groupAllowlist: string[];
  allowProactivePrivate: boolean;
  allowProactiveGroup: boolean;
  /** Enable full group message stream (`GROUP_MESSAGE_CREATE`) when permitted. */
  receiveAllGroupMessages: boolean;
  tokenUrl: string;
  apiBaseUrl: string;
  restTimeoutMs: number;
  /** Passive reply window advertised by the platform, in seconds. */
  passiveReplyWindowSeconds: number;
}

export interface StorageConfig {
  sqlitePath: string;
  /** How long inbound dedupe keys are kept. */
  dedupeTtlSeconds: number;
  /** How many messages are retained for the console. */
  messageRetentionDays: number;
}

export interface LoggingConfig {
  level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  pretty: boolean;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  server: {
    host: '0.0.0.0',
    onebotPort: 8098,
    healthPort: 8080,
    websocketPath: '/onebot/v11/ws',
    dataDir: './data',
  },
  web: {
    enabled: true,
    host: '0.0.0.0',
    port: 3000,
    adminAuth: true,
    sessionSecretEnv: 'WEB_SESSION_SECRET',
    adminPasswordHashEnv: 'WEB_ADMIN_PASSWORD_HASH',
    corsOrigins: [],
    staticDir: 'apps/web/dist',
    sessionTtlSeconds: 12 * 60 * 60,
  },
  replyPolicy: {
    defaultMode: 'mention_only',
    allowPrivateWithoutMention: true,
    allowGroupWithoutMention: false,
    allowChannelWithoutMention: false,
    whitelistUserIds: [],
    whitelistGroupIds: [],
  },
  rules: {
    enabled: true,
    defaultAction: 'ignore',
    stopOnFirstMatch: true,
  },
  onebot: {
    accessTokenEnv: 'ONEBOT_BRIDGE_TOKEN',
    actionTimeoutMs: 10_000,
    maxPendingActions: 256,
    heartbeatIntervalSeconds: 30,
    requireAccessToken: false,
  },
  discord: {
    enabled: false,
    tokenEnv: 'DISCORD_BOT_TOKEN',
    guildAllowlist: [],
    channelAllowlist: [],
    intents: {
      guilds: true,
      guildMessages: true,
      messageContent: true,
      directMessages: true,
    },
    apiBaseUrl: 'https://discord.com/api/v10',
    gatewayUrl: 'wss://gateway.discord.gg/?v=10&encoding=json',
    restTimeoutMs: 15_000,
  },
  qq: {
    enabled: false,
    appIdEnv: 'QQ_APP_ID',
    appSecretEnv: 'QQ_APP_SECRET',
    groupAllowlist: [],
    allowProactivePrivate: true,
    allowProactiveGroup: false,
    receiveAllGroupMessages: false,
    tokenUrl: 'https://bots.qq.com/app/getAppAccessToken',
    apiBaseUrl: 'https://api.sgroup.qq.com',
    restTimeoutMs: 15_000,
    passiveReplyWindowSeconds: 300,
  },
  storage: {
    sqlitePath: './data/bridge.sqlite',
    dedupeTtlSeconds: 24 * 60 * 60,
    messageRetentionDays: 30,
  },
  retry: {
    maxAttempts: 5,
    initialDelayMs: 1000,
    maxDelayMs: 60_000,
    jitterRatio: 0.2,
  },
  logging: {
    level: 'info',
    pretty: false,
  },
  capabilities: {},
};
