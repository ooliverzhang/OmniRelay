import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../apps/server/src/config.js';

const HASH_ENV = { WEB_ADMIN_PASSWORD_HASH: 'scrypt$16384$8$1$c2FsdA$aGFzaA' };

describe('loadConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-relay-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(content: string): string {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, content, 'utf8');
    return path;
  }

  it('maps the shipped example config to camelCase without snake_case leftovers', () => {
    const { config, warnings } = loadConfig({
      configPath: resolve(process.cwd(), 'config.example.yaml'),
      cwd: dir,
      env: HASH_ENV,
    });

    expect(warnings).toEqual([]);
    expect(config.server).toEqual({
      host: '0.0.0.0',
      onebotPort: 8098,
      healthPort: 8080,
      websocketPath: '/onebot/v11/ws',
      dataDir: resolve(dir, 'data'),
    });
    expect(config.web).toMatchObject({
      enabled: true,
      port: 3000,
      adminAuth: true,
      sessionSecretEnv: 'WEB_SESSION_SECRET',
      adminPasswordHashEnv: 'WEB_ADMIN_PASSWORD_HASH',
      corsOrigins: [],
      sessionTtlSeconds: 43_200,
    });
    expect(Object.keys(config.retry).sort()).toEqual([
      'initialDelayMs',
      'jitterRatio',
      'maxAttempts',
      'maxDelayMs',
    ]);
    expect(Object.keys(config.onebot).sort()).toEqual([
      'accessTokenEnv',
      'actionTimeoutMs',
      'heartbeatIntervalSeconds',
      'maxPendingActions',
      'requireAccessToken',
    ]);
    expect(Object.keys(config.storage).sort()).toEqual([
      'dedupeTtlSeconds',
      'messageRetentionDays',
      'sqlitePath',
    ]);
    expect(config.replyPolicy.defaultMode).toBe('mention_only');
    expect(config.discord.intents).toEqual({
      guilds: true,
      guildMessages: true,
      messageContent: true,
      directMessages: true,
    });
    expect(config.qq.allowProactiveGroup).toBe(false);
    expect(config.qq.receiveAllGroupMessages).toBe(false);
    expect(config.logging).toEqual({ level: 'info', pretty: false });
  });

  it('applies YAML overrides to every section', () => {
    const path = writeConfig(
      [
        'server:',
        '  onebot_port: 9100',
        '  health_port: 9101',
        '  websocket_path: /custom/ws',
        'web:',
        '  port: 3100',
        '  static_dir: ./dist-custom',
        'onebot:',
        '  action_timeout_ms: 4321',
        '  access_token_env: CUSTOM_ONEBOT_TOKEN',
        'reply_policy:',
        '  default_mode: always',
        '  whitelist_group_ids: ["g-1"]',
        'rules:',
        '  stop_on_first_match: false',
        'discord:',
        '  enabled: true',
        '  token_env: CUSTOM_DISCORD_TOKEN',
        '  guild_allowlist: ["123"]',
        '  rest_timeout_ms: 5000',
        '  intents:',
        '    message_content: false',
        'qq:',
        '  app_id_env: CUSTOM_APP_ID',
        '  allow_proactive_group: true',
        'storage:',
        '  sqlite_path: ./custom.sqlite',
        '  dedupe_ttl_seconds: 60',
        '  message_retention_days: 7',
        'retry:',
        '  max_attempts: 3',
        '  initial_delay_ms: 250',
        'logging:',
        '  level: debug',
        '',
      ].join('\n'),
    );

    const { config } = loadConfig({ configPath: path, cwd: dir, env: HASH_ENV });

    expect(config.server.onebotPort).toBe(9100);
    expect(config.server.healthPort).toBe(9101);
    expect(config.server.websocketPath).toBe('/custom/ws');
    expect(config.web.port).toBe(3100);
    expect(config.web.staticDir).toBe(resolve(dir, 'dist-custom'));
    expect(config.onebot.actionTimeoutMs).toBe(4321);
    expect(config.onebot.accessTokenEnv).toBe('CUSTOM_ONEBOT_TOKEN');
    expect(config.replyPolicy.defaultMode).toBe('always');
    expect(config.replyPolicy.whitelistGroupIds).toEqual(['g-1']);
    expect(config.rules.stopOnFirstMatch).toBe(false);
    expect(config.discord.enabled).toBe(true);
    expect(config.discord.tokenEnv).toBe('CUSTOM_DISCORD_TOKEN');
    expect(config.discord.guildAllowlist).toEqual(['123']);
    expect(config.discord.restTimeoutMs).toBe(5000);
    expect(config.discord.intents.messageContent).toBe(false);
    expect(config.qq.appIdEnv).toBe('CUSTOM_APP_ID');
    expect(config.qq.allowProactiveGroup).toBe(true);
    expect(config.storage.sqlitePath).toBe(resolve(dir, 'custom.sqlite'));
    expect(config.storage.dedupeTtlSeconds).toBe(60);
    expect(config.storage.messageRetentionDays).toBe(7);
    expect(config.retry).toEqual({
      maxAttempts: 3,
      initialDelayMs: 250,
      maxDelayMs: 60_000,
      jitterRatio: 0.2,
    });
    expect(config.logging.level).toBe('debug');
  });

  it('rejects unknown keys with a helpful message', () => {
    const path = writeConfig('server:\n  onebot_port: 8098\nunknown_section:\n  x: 1\n');
    expect(() => loadConfig({ configPath: path, cwd: dir, env: HASH_ENV })).toThrow(ConfigError);
  });

  it('refuses to start with admin auth enabled but no password hash', () => {
    const path = writeConfig('web:\n  admin_auth: true\n');
    expect(() => loadConfig({ configPath: path, cwd: dir, env: {} })).toThrow(
      /WEB_ADMIN_PASSWORD_HASH is not set/,
    );
  });

  it('applies environment overrides for ports, paths and logging', () => {
    const { config } = loadConfig({
      configPath: resolve(process.cwd(), 'config.example.yaml'),
      cwd: dir,
      env: {
        ...HASH_ENV,
        OMNI_RELAY_ONEBOT_PORT: '9200',
        OMNI_RELAY_HEALTH_PORT: '9201',
        OMNI_RELAY_WEB_PORT: '3200',
        OMNI_RELAY_SQLITE_PATH: './env.sqlite',
        OMNI_RELAY_LOG_LEVEL: 'warn',
        OMNI_RELAY_LOG_PRETTY: 'true',
      },
    });
    expect(config.server.onebotPort).toBe(9200);
    expect(config.server.healthPort).toBe(9201);
    expect(config.web.port).toBe(3200);
    expect(config.storage.sqlitePath).toBe(resolve(dir, 'env.sqlite'));
    expect(config.logging.level).toBe('warn');
    expect(config.logging.pretty).toBe(true);
  });

  it('rejects conflicting ports and invalid env values', () => {
    const conflict = writeConfig('server:\n  onebot_port: 3000\nweb:\n  port: 3000\n');
    expect(() => loadConfig({ configPath: conflict, cwd: dir, env: HASH_ENV })).toThrow(
      /must differ/,
    );

    expect(() =>
      loadConfig({
        configPath: null as unknown as string,
        cwd: dir,
        env: { ...HASH_ENV, OMNI_RELAY_ONEBOT_PORT: 'not-a-number' },
      }),
    ).toThrow(ConfigError);
  });
});
