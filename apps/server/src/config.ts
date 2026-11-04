import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { DEFAULT_APP_CONFIG, type AppConfig } from '@omni-relay/shared-types';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

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
    intents: z
      .object({
        guilds: z.boolean(),
        guild_messages: z.boolean(),
        message_content: z.boolean(),
        direct_messages: z.boolean(),
      })
      .partial(),
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

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);

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
    capabilities: z
      .object({
        discord: capabilityFlagSchema,
        'qq-official': capabilityFlagSchema,
      })
      .partial(),
  })
  .partial();

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

function definedOnly<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      out[key] = entry;
    }
  }
  return out as Partial<T>;
}

/**
 * Loads `config.yaml` (when present), validates it, and merges it over the
 * built-in defaults. Environment variables only override ports/paths and log
 * settings; secrets are always read from the environment at use time.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadConfigResult {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const warnings: string[] = [];

  const explicitPath = options.configPath ?? env['OMNI_RELAY_CONFIG'] ?? undefined;
  const configPath = explicitPath
    ? resolve(cwd, explicitPath)
    : findDefaultConfig(cwd);

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
        `invalid config in ${configPath}:\n${formatZodError(result.error)}\n${formatZodPaths(result.error)}`,
      );
    }
    parsed = result.data;
  }

  const config = mergeConfig(parsed, warnings);
  applyEnvironmentOverrides(config, env);
  resolvePaths(config, cwd);
  validateResolvedConfig(config);
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
  const toAbsolute = (value: string | undefined, fallback: string): string => value ?? fallback;

  const server = file.server ?? {};
  const web = file.web ?? {};
  const onebot = file.onebot ?? {};
  const discord = file.discord ?? {};
  const qq = file.qq ?? {};
  const storage = file.storage ?? {};
  const retry = file.retry ?? {};
  const logging = file.logging ?? {};
  const policy = file.reply_policy ?? {};
  const rules = file.rules ?? {};

  if (server.websocket_path && onebot.websocket_path && server.websocket_path !== onebot.websocket_path) {
    warnings.push(
      `server.websocket_path (${server.websocket_path}) differs from onebot.websocket_path (${onebot.websocket_path}); using server.websocket_path`,
    );
  }

  const config: AppConfig = {
    server: {
      ...defaults.server,
      ...definedOnly(server),
      ...(server.onebot_port === undefined && onebot.listen_port !== undefined
        ? { onebotPort: onebot.listen_port }
        : {}),
      ...(server.websocket_path === undefined && onebot.websocket_path !== undefined
        ? { websocketPath: onebot.websocket_path }
        : {}),
      ...(server.host === undefined && onebot.listen_host !== undefined
        ? { host: onebot.listen_host }
        : {}),
      ...(server.health_port === undefined && web.port !== undefined ? {} : {}),
    },
    web: {
      ...defaults.web,
      ...definedOnly(web),
    },
    replyPolicy: {
      ...defaults.replyPolicy,
      ...(policy.default_mode === undefined ? {} : { defaultMode: policy.default_mode }),
      ...(policy.allow_private_without_mention === undefined
        ? {}
        : { allowPrivateWithoutMention: policy.allow_private_without_mention }),
      ...(policy.allow_group_without_mention === undefined
        ? {}
        : { allowGroupWithoutMention: policy.allow_group_without_mention }),
      ...(policy.allow_channel_without_mention === undefined
        ? {}
        : { allowChannelWithoutMention: policy.allow_channel_without_mention }),
      ...(policy.whitelist_user_ids === undefined
        ? {}
        : { whitelistUserIds: policy.whitelist_user_ids }),
      ...(policy.whitelist_group_ids === undefined
        ? {}
        : { whitelistGroupIds: policy.whitelist_group_ids }),
    },
    rules: {
      ...defaults.rules,
      ...(rules.enabled === undefined ? {} : { enabled: rules.enabled }),
      ...(rules.default_action === undefined ? {} : { defaultAction: rules.default_action }),
      ...(rules.stop_on_first_match === undefined
        ? {}
        : { stopOnFirstMatch: rules.stop_on_first_match }),
    },
    onebot: {
      ...defaults.onebot,
      ...definedOnly(onebot),
    },
    discord: {
      ...defaults.discord,
      ...definedOnly(discord),
      intents: {
        ...defaults.discord.intents,
        ...(discord.intents?.guilds === undefined ? {} : { guilds: discord.intents.guilds }),
        ...(discord.intents?.guild_messages === undefined
          ? {}
          : { guildMessages: discord.intents.guild_messages }),
        ...(discord.intents?.message_content === undefined
          ? {}
          : { messageContent: discord.intents.message_content }),
        ...(discord.intents?.direct_messages === undefined
          ? {}
          : { directMessages: discord.intents.direct_messages }),
      },
      ...(discord.message_content_intent === undefined
        ? {}
        : { intents: {
            ...defaults.discord.intents,
            ...(discord.intents?.guilds === undefined ? {} : { guilds: discord.intents.guilds }),
            ...(discord.intents?.guild_messages === undefined
              ? {}
              : { guildMessages: discord.intents.guild_messages }),
            messageContent: discord.message_content_intent,
            ...(discord.intents?.direct_messages === undefined
              ? {}
              : { directMessages: discord.intents.direct_messages }),
          } }),
    },
    qq: {
      ...defaults.qq,
      ...definedOnly(qq),
    },
    storage: {
      ...defaults.storage,
      ...definedOnly(storage),
    },
    retry: {
      ...defaults.retry,
      ...definedOnly(retry),
    },
    logging: {
      ...defaults.logging,
      ...definedOnly(logging),
    },
    capabilities: {
      ...(file.capabilities?.discord === undefined
        ? {}
        : { discord: file.capabilities.discord }),
      ...(file.capabilities?.['qq-official'] === undefined
        ? {}
        : { 'qq-official': file.capabilities['qq-official'] }),
    },
  };

  void toAbsolute;
  return config;
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
      throw new ConfigError(`OMNI_RELAY_LOG_LEVEL must be one of fatal|error|warn|info|debug|trace`);
    }
    config.logging.level = parsedLevel.data;
  }
  const pretty = stringFromEnv('OMNI_RELAY_LOG_PRETTY');
  if (pretty !== undefined) {
    config.logging.pretty = pretty === '1' || pretty.toLowerCase() === 'true';
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
  mkdirSync(config.server.dataDir, { recursive: true });
  if (config.storage.sqlitePath !== ':memory:') {
    mkdirSync(resolve(config.storage.sqlitePath, '..'), { recursive: true });
  }
}

function validateResolvedConfig(config: AppConfig): void {
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
    if (!process.env[hashEnv]) {
      throw new ConfigError(
        `web.admin_auth is enabled but ${hashEnv} is not set. Generate a hash with "npm run hash-password" and export it, or set web.admin_auth to false for local-only development.`,
      );
    }
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('\n');
}

function formatZodPaths(error: z.ZodError): string {
  const unknownKeys = error.issues.filter((issue) => issue.code === 'unrecognized_keys');
  if (unknownKeys.length === 0) {
    return '';
  }
  const names = unknownKeys.flatMap((issue) =>
    (issue as unknown as { keys?: string[] }).keys ?? [],
  );
  return names.length > 0 ? `unknown config keys: ${names.join(', ')}` : '';
}
