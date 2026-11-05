import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { DEFAULT_APP_CONFIG, type AppConfig } from '@omni-relay/shared-types';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);

const serverSchema = z
  .object({
    host: z.string().min(1),
    onebot_port: z.number().int().min(0).max(65535),
    health_port: z.number().int().min(0).max(65535),
    websocket_path: z.string().startsWith('/'),
    data_dir: z.string().min(1),
  })
  .partial();

const webSchema = z
  .object({
    enabled: z.boolean(),
    host: z.string().min(1),
    port: z.number().int().min(0).max(65535),
    admin_auth: z.boolean(),
    session_secret_env: z.string().min(1),
    admin_password_hash_env: z.string().min(1),
    cors_origins: z.array(z.string()),
    static_dir: z.string().min(1),
    session_ttl_seconds: z.number().int().positive(),
  })
  .partial();

const replyPolicySchema = z
  .object({
    default_mode: z.enum(['always', 'mention_only', 'private_only', 'whitelist', 'disabled']),
    allow_private_without_mention: z.boolean(),
    allow_group_without_mention: z.boolean(),
    allow_channel_without_mention: z.boolean(),
    whitelist_user_ids: z.array(z.string()),
    whitelist_group_ids: z.array(z.string()),
  })
  .partial();

const rulesSchema = z
  .object({
    enabled: z.boolean(),
    default_action: z.literal('ignore'),
    stop_on_first_match: z.boolean(),
  })
  .partial();

const onebotSchema = z
  .object({
    access_token_env: z.string().min(1),
    action_timeout_ms: z.number().int().positive(),
    max_pending_actions: z.number().int().positive(),
    heartbeat_interval_seconds: z.number().int().positive(),
    require_access_token: z.boolean(),
    listen_host: z.string().min(1),
    listen_port: z.number().int().min(0).max(65535),
    websocket_path: z.string().startsWith('/'),
  })
  .partial();

const discordIntentsSchema = z
  .object({
    guilds: z.boolean(),
    guild_messages: z.boolean(),
    message_content: z.boolean(),
    direct_messages: z.boolean(),
  })
  .partial();

const discordSchema = z
  .object({
    enabled: z.boolean(),
    token_env: z.string().min(1),
    guild_allowlist: z.array(z.string()),
    channel_allowlist: z.array(z.string()),
    message_content_intent: z.boolean(),
    api_base_url: z.string().url(),
    gateway_url: z.string().url(),
    rest_timeout_ms: z.number().int().positive(),
    intents: discordIntentsSchema,
  })
  .partial();

const qqSchema = z
  .object({
    enabled: z.boolean(),
    app_id_env: z.string().min(1),
    app_secret_env: z.string().min(1),
    group_allowlist: z.array(z.string()),
    allow_proactive_private: z.boolean(),
    allow_proactive_group: z.boolean(),
    receive_all_group_messages: z.boolean(),
    token_url: z.string().url(),
    api_base_url: z.string().url(),
    rest_timeout_ms: z.number().int().positive(),
    passive_reply_window_seconds: z.number().int().positive(),
  })
  .partial();

const storageSchema = z
  .object({
    sqlite_path: z.string().min(1),
    dedupe_ttl_seconds: z.number().int().positive(),
    message_retention_days: z.number().int().positive(),
  })
  .partial();

const retrySchema = z
  .object({
    max_attempts: z.number().int().positive(),
    initial_delay_ms: z.number().int().positive(),
    max_delay_ms: z.number().int().positive(),
    jitter_ratio: z.number().min(0).max(1),
  })
  .partial();

const loggingSchema = z
  .object({
    level: logLevelSchema,
    pretty: z.boolean(),
  })
  .partial();

const capabilityFlagSchema = z
  .object({
    privateReceive: z.boolean(),
    privateReply: z.boolean(),
    privateProactiveSend: z.boolean(),
    groupReceive: z.boolean(),
    groupMentionReceive: z.boolean(),
    groupReply: z.boolean(),
    groupProactiveSend: z.boolean(),
    broadcast: z.boolean(),
  })
  .partial();

const credentialsSchema = z
  .object({
    env_file: z.string().min(1),
    allow_console_write: z.boolean(),
  })
  .partial();

const capabilitiesSchema = z
  .object({
    discord: capabilityFlagSchema,
    'qq-official': capabilityFlagSchema,
  })
  .partial();

const fileSchema = z
  .object({
    server: serverSchema,
    web: webSchema,
    reply_policy: replyPolicySchema,
    rules: rulesSchema,
    onebot: onebotSchema,
    discord: discordSchema,
    qq: qqSchema,
    storage: storageSchema,
    retry: retrySchema,
    logging: loggingSchema,
    credentials: credentialsSchema,
    capabilities: capabilitiesSchema,
  })
  .partial()
  .strict();

export type ConfigFile = z.infer<typeof fileSchema>;

export interface LoadConfigOptions {
  configPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  cwd?: string | undefined;
}

export interface LoadConfigResult {
  config: AppConfig;
  configPath: string | null;
  warnings: string[];
}

const DEFAULT_CONFIG_FILENAMES = ['config.yaml', 'config.yml'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Loads `config.yaml` (when present), validates it with zod, and merges it over
 * the built-in defaults using an explicit snake_case → camelCase mapping.
 *
 * Environment variables only override ports/paths and log settings; secrets are
 * always read from the environment at the point of use, never stored.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadConfigResult {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const warnings: string[] = [];

  const explicitPath = options.configPath ?? env['OMNI_RELAY_CONFIG'] ?? undefined;
  const configPath = explicitPath ? resolve(cwd, explicitPath) : findDefaultConfig(cwd);

  let parsed: ConfigFile = {};
  if (configPath) {
    if (!existsSync(configPath)) {
      throw new ConfigError(`config file not found: ${configPath}`);
    }
    const raw = readFileSync(configPath, 'utf8');
    let yamlValue: unknown;
    try {
      yamlValue = parseYaml(raw);
    } catch (error) {
      throw new ConfigError(
        `invalid YAML in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (yamlValue === null || yamlValue === undefined) {
      yamlValue = {};
    }
    if (!isPlainObject(yamlValue)) {
      throw new ConfigError(`config file must contain a mapping at the root: ${configPath}`);
    }
    const result = fileSchema.safeParse(yamlValue);
    if (!result.success) {
      throw new ConfigError(
        `invalid config in ${configPath}:\n${formatZodError(result.error)}${formatUnknownKeys(result.error)}`,
      );
    }
    parsed = result.data;
  }

  const config = mergeConfig(parsed, warnings);
  applyEnvironmentOverrides(config, env);
  resolvePaths(config, cwd);
  validateResolvedConfig(config, env);
  return { config, configPath: configPath ?? null, warnings };
}

function findDefaultConfig(cwd: string): string | null {
  for (const name of DEFAULT_CONFIG_FILENAMES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function mergeConfig(file: ConfigFile, warnings: string[]): AppConfig {
  const defaults = DEFAULT_APP_CONFIG;
  const server = file.server ?? {};
  const web = file.web ?? {};
  const onebot = file.onebot ?? {};
  const discord = file.discord ?? {};
  const qq = file.qq ?? {};
  const storage = file.storage ?? {};
  const retry = file.retry ?? {};
  const logging = file.logging ?? {};
  const credentials = file.credentials ?? {};
  const policy = file.reply_policy ?? {};
  const rules = file.rules ?? {};
  const capabilities = file.capabilities ?? {};

  if (
    server.websocket_path !== undefined &&
    onebot.websocket_path !== undefined &&
    server.websocket_path !== onebot.websocket_path
  ) {
    warnings.push(
      `server.websocket_path (${server.websocket_path}) differs from onebot.websocket_path (${onebot.websocket_path}); using server.websocket_path`,
    );
  }

  return {
    server: {
      host: server.host ?? onebot.listen_host ?? defaults.server.host,
      onebotPort: server.onebot_port ?? onebot.listen_port ?? defaults.server.onebotPort,
      healthPort: server.health_port ?? defaults.server.healthPort,
      websocketPath:
        server.websocket_path ?? onebot.websocket_path ?? defaults.server.websocketPath,
      dataDir: server.data_dir ?? defaults.server.dataDir,
    },
    web: {
      enabled: web.enabled ?? defaults.web.enabled,
      host: web.host ?? defaults.web.host,
      port: web.port ?? defaults.web.port,
      adminAuth: web.admin_auth ?? defaults.web.adminAuth,
      sessionSecretEnv: web.session_secret_env ?? defaults.web.sessionSecretEnv,
      adminPasswordHashEnv: web.admin_password_hash_env ?? defaults.web.adminPasswordHashEnv,
      corsOrigins: web.cors_origins ?? [...defaults.web.corsOrigins],
      staticDir: web.static_dir ?? defaults.web.staticDir,
      sessionTtlSeconds: web.session_ttl_seconds ?? defaults.web.sessionTtlSeconds,
    },
    replyPolicy: {
      defaultMode: policy.default_mode ?? defaults.replyPolicy.defaultMode,
      allowPrivateWithoutMention:
        policy.allow_private_without_mention ?? defaults.replyPolicy.allowPrivateWithoutMention,
      allowGroupWithoutMention:
        policy.allow_group_without_mention ?? defaults.replyPolicy.allowGroupWithoutMention,
      allowChannelWithoutMention:
        policy.allow_channel_without_mention ?? defaults.replyPolicy.allowChannelWithoutMention,
      whitelistUserIds: policy.whitelist_user_ids ?? [...defaults.replyPolicy.whitelistUserIds],
      whitelistGroupIds: policy.whitelist_group_ids ?? [...defaults.replyPolicy.whitelistGroupIds],
    },
    rules: {
      enabled: rules.enabled ?? defaults.rules.enabled,
      defaultAction: rules.default_action ?? defaults.rules.defaultAction,
      stopOnFirstMatch: rules.stop_on_first_match ?? defaults.rules.stopOnFirstMatch,
    },
    onebot: {
      accessTokenEnv: onebot.access_token_env ?? defaults.onebot.accessTokenEnv,
      actionTimeoutMs: onebot.action_timeout_ms ?? defaults.onebot.actionTimeoutMs,
      maxPendingActions: onebot.max_pending_actions ?? defaults.onebot.maxPendingActions,
      heartbeatIntervalSeconds:
        onebot.heartbeat_interval_seconds ?? defaults.onebot.heartbeatIntervalSeconds,
      requireAccessToken: onebot.require_access_token ?? defaults.onebot.requireAccessToken,
    },
    discord: {
      enabled: discord.enabled ?? defaults.discord.enabled,
      tokenEnv: discord.token_env ?? defaults.discord.tokenEnv,
      guildAllowlist: discord.guild_allowlist ?? [...defaults.discord.guildAllowlist],
      channelAllowlist: discord.channel_allowlist ?? [...defaults.discord.channelAllowlist],
      intents: {
        guilds: discord.intents?.guilds ?? defaults.discord.intents.guilds,
        guildMessages: discord.intents?.guild_messages ?? defaults.discord.intents.guildMessages,
        messageContent:
          discord.intents?.message_content ??
          discord.message_content_intent ??
          defaults.discord.intents.messageContent,
        directMessages: discord.intents?.direct_messages ?? defaults.discord.intents.directMessages,
      },
      apiBaseUrl: discord.api_base_url ?? defaults.discord.apiBaseUrl,
      gatewayUrl: discord.gateway_url ?? defaults.discord.gatewayUrl,
      restTimeoutMs: discord.rest_timeout_ms ?? defaults.discord.restTimeoutMs,
    },
    qq: {
      enabled: qq.enabled ?? defaults.qq.enabled,
      appIdEnv: qq.app_id_env ?? defaults.qq.appIdEnv,
      appSecretEnv: qq.app_secret_env ?? defaults.qq.appSecretEnv,
      groupAllowlist: qq.group_allowlist ?? [...defaults.qq.groupAllowlist],
      allowProactivePrivate: qq.allow_proactive_private ?? defaults.qq.allowProactivePrivate,
      allowProactiveGroup: qq.allow_proactive_group ?? defaults.qq.allowProactiveGroup,
      receiveAllGroupMessages: qq.receive_all_group_messages ?? defaults.qq.receiveAllGroupMessages,
      tokenUrl: qq.token_url ?? defaults.qq.tokenUrl,
      apiBaseUrl: qq.api_base_url ?? defaults.qq.apiBaseUrl,
      restTimeoutMs: qq.rest_timeout_ms ?? defaults.qq.restTimeoutMs,
      passiveReplyWindowSeconds:
        qq.passive_reply_window_seconds ?? defaults.qq.passiveReplyWindowSeconds,
    },
    storage: {
      sqlitePath: storage.sqlite_path ?? defaults.storage.sqlitePath,
      dedupeTtlSeconds: storage.dedupe_ttl_seconds ?? defaults.storage.dedupeTtlSeconds,
      messageRetentionDays: storage.message_retention_days ?? defaults.storage.messageRetentionDays,
    },
    retry: {
      maxAttempts: retry.max_attempts ?? defaults.retry.maxAttempts,
      initialDelayMs: retry.initial_delay_ms ?? defaults.retry.initialDelayMs,
      maxDelayMs: retry.max_delay_ms ?? defaults.retry.maxDelayMs,
      jitterRatio: retry.jitter_ratio ?? defaults.retry.jitterRatio,
    },
    logging: {
      level: logging.level ?? defaults.logging.level,
      pretty: logging.pretty ?? defaults.logging.pretty,
    },
    credentials: {
      envFile: credentials.env_file ?? defaults.credentials.envFile,
      allowConsoleWrite: credentials.allow_console_write ?? defaults.credentials.allowConsoleWrite,
    },
    capabilities: {
      ...(capabilities.discord === undefined ? {} : { discord: capabilities.discord }),
      ...(capabilities['qq-official'] === undefined
        ? {}
        : { 'qq-official': capabilities['qq-official'] }),
    },
  };
}

function applyEnvironmentOverrides(config: AppConfig, env: NodeJS.ProcessEnv): void {
  const numberFromEnv = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
      return undefined;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new ConfigError(`environment variable ${name} must be a number`);
    }
    return Math.trunc(value);
  };
  const stringFromEnv = (name: string): string | undefined => {
    const raw = env[name];
    return raw === undefined || raw.trim() === '' ? undefined : raw;
  };

  const onebotPort = numberFromEnv('OMNI_RELAY_ONEBOT_PORT');
  if (onebotPort !== undefined) {
    config.server.onebotPort = onebotPort;
  }
  const healthPort = numberFromEnv('OMNI_RELAY_HEALTH_PORT');
  if (healthPort !== undefined) {
    config.server.healthPort = healthPort;
  }
  const webPort = numberFromEnv('OMNI_RELAY_WEB_PORT');
  if (webPort !== undefined) {
    config.web.port = webPort;
  }
  const dataDir = stringFromEnv('OMNI_RELAY_DATA_DIR');
  if (dataDir !== undefined) {
    config.server.dataDir = dataDir;
  }
  const sqlitePath = stringFromEnv('OMNI_RELAY_SQLITE_PATH');
  if (sqlitePath !== undefined) {
    config.storage.sqlitePath = sqlitePath;
  }
  const logLevel = stringFromEnv('OMNI_RELAY_LOG_LEVEL');
  if (logLevel !== undefined) {
    const parsedLevel = logLevelSchema.safeParse(logLevel);
    if (!parsedLevel.success) {
      throw new ConfigError(
        'OMNI_RELAY_LOG_LEVEL must be one of fatal|error|warn|info|debug|trace',
      );
    }
    config.logging.level = parsedLevel.data;
  }
  const pretty = stringFromEnv('OMNI_RELAY_LOG_PRETTY');
  if (pretty !== undefined) {
    config.logging.pretty = pretty === '1' || pretty.toLowerCase() === 'true';
  }
  const envFile = stringFromEnv('OMNI_RELAY_ENV_FILE');
  if (envFile !== undefined) {
    // Still subject to the project-root boundary check in resolvePaths.
    config.credentials.envFile = envFile;
  }
  const allowConsoleWrite = stringFromEnv('OMNI_RELAY_ALLOW_CONSOLE_WRITE');
  if (allowConsoleWrite !== undefined) {
    config.credentials.allowConsoleWrite =
      allowConsoleWrite === '1' || allowConsoleWrite.toLowerCase() === 'true';
  }
}

function resolvePaths(config: AppConfig, cwd: string): void {
  config.server.dataDir = isAbsolute(config.server.dataDir)
    ? config.server.dataDir
    : resolve(cwd, config.server.dataDir);
  config.storage.sqlitePath =
    config.storage.sqlitePath === ':memory:'
      ? ':memory:'
      : isAbsolute(config.storage.sqlitePath)
        ? config.storage.sqlitePath
        : resolve(cwd, config.storage.sqlitePath);
  config.web.staticDir = isAbsolute(config.web.staticDir)
    ? config.web.staticDir
    : resolve(cwd, config.web.staticDir);

  // The credentials file is writable from the console, so it must stay inside
  // the project root; a `../` or absolute escape would let a request rewrite
  // anything the process can reach.
  const envFile = resolve(cwd, config.credentials.envFile);
  if (!isWithinProjectRoot(cwd, envFile)) {
    throw new ConfigError(
      `credentials.env_file must resolve inside the project root (${cwd}); got: ${envFile}`,
    );
  }
  config.credentials.envFile = envFile;

  mkdirSync(config.server.dataDir, { recursive: true });
  if (config.storage.sqlitePath !== ':memory:') {
    mkdirSync(resolve(config.storage.sqlitePath, '..'), { recursive: true });
  }
}

/**
 * Returns whether `target` resolves to `root` itself or a path below it.
 *
 * Both arguments are resolved against the current working directory when they
 * are relative, so callers can pass raw config values.
 */
export function isWithinProjectRoot(root: string, target: string): boolean {
  const rootAbsolute = resolve(root);
  const targetAbsolute = resolve(target);
  const relativePath = relative(rootAbsolute, targetAbsolute);
  if (relativePath === '') {
    return true;
  }
  return !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function validateResolvedConfig(config: AppConfig, env: NodeJS.ProcessEnv): void {
  if (config.server.onebotPort === config.web.port) {
    throw new ConfigError('server.onebot_port must differ from web.port');
  }
  if (config.server.onebotPort === config.server.healthPort) {
    throw new ConfigError('server.onebot_port must differ from server.health_port');
  }
  if (config.web.enabled && config.server.healthPort === config.web.port) {
    throw new ConfigError('server.health_port must differ from web.port');
  }
  if (config.retry.maxDelayMs < config.retry.initialDelayMs) {
    throw new ConfigError('retry.max_delay_ms must be >= retry.initial_delay_ms');
  }
  if (config.onebot.maxPendingActions < 1) {
    throw new ConfigError('onebot.max_pending_actions must be >= 1');
  }
  if (config.web.adminAuth) {
    const hashEnv = config.web.adminPasswordHashEnv;
    if (!env[hashEnv]) {
      throw new ConfigError(
        `web.admin_auth is enabled but ${hashEnv} is not set. Generate a hash with "npm run hash-password" and export it, or set web.admin_auth to false for local-only development.`,
      );
    }
  }
  if (config.onebot.requireAccessToken && !env[config.onebot.accessTokenEnv]) {
    throw new ConfigError(
      `onebot.require_access_token is enabled but ${config.onebot.accessTokenEnv} is not set`,
    );
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('\n');
}

function formatUnknownKeys(error: z.ZodError): string {
  const keys = error.issues
    .filter((issue) => issue.code === 'unrecognized_keys')
    .flatMap((issue) => (issue as unknown as { keys?: string[] }).keys ?? []);
  return keys.length > 0 ? `\nunknown config keys: ${keys.join(', ')}` : '';
}
