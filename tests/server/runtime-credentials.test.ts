import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@omni-relay/shared-types';

import { BridgeRuntime } from '../../apps/server/src/runtime.js';
import { FakeSocket, createFakeSocketFactory } from '../helpers/fake-socket.js';
import { createSilentLogger, createTempStorage, createTestConfig } from '../helpers/harness.js';

function buildRuntime(env: Record<string, string>) {
  FakeSocket.reset();
  const store = createTempStorage();
  const config = createTestConfig({
    discord: { ...DEFAULT_APP_CONFIG.discord, enabled: true, tokenEnv: 'DISCORD_BOT_TOKEN' },
    qq: {
      ...DEFAULT_APP_CONFIG.qq,
      enabled: true,
      appIdEnv: 'QQ_APP_ID',
      appSecretEnv: 'QQ_APP_SECRET',
    },
  });
  const runtime = new BridgeRuntime({
    config,
    storage: store.storage,
    logger: createSilentLogger(),
    env: { ...env } as NodeJS.ProcessEnv,
    transport: {
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
      createSocket: createFakeSocketFactory(),
    },
  });
  return { runtime, store };
}

describe('reloadPlatformCredentials', () => {
  it('builds an adapter once a Discord token appears', async () => {
    const { runtime, store } = buildRuntime({ TEST_ONEBOT_TOKEN: 'onebot-secret' });
    try {
      await runtime.start();
      expect(runtime.getPlatformView('discord').credentials[0]?.state).toBe('missing');
      expect(runtime.getPlatformConnection('discord').connection).toBe('unconfigured');

      runtime.applyCredentialValue('DISCORD_BOT_TOKEN', 'test-bot-token-value');
      await runtime.reloadPlatformCredentials('discord');

      const view = runtime.getPlatformView('discord');
      expect(view.credentials[0]?.state).toBe('configured');
      expect(view.credentials[0]?.masked).toContain('…');
      expect(view.credentials[0]?.masked).not.toBe('test-bot-token-value');
      expect(runtime.getPlatformConnection('discord').connection).not.toBe('unconfigured');
    } finally {
      await runtime.stop();
      store.cleanup();
      delete process.env['DISCORD_BOT_TOKEN'];
    }
  });

  it('closes the previous gateway instead of leaking the connection', async () => {
    const { runtime, store } = buildRuntime({
      TEST_ONEBOT_TOKEN: 'onebot-secret',
      DISCORD_BOT_TOKEN: 'test-bot-token-value',
    });
    try {
      await runtime.start();
      // First adapter dialled once.
      expect(FakeSocket.instances.length).toBe(1);
      const firstSocket = FakeSocket.latest();
      const closeSpy = vi.spyOn(firstSocket, 'close');

      runtime.applyCredentialValue('DISCORD_BOT_TOKEN', 'rotated-bot-token-value');
      await runtime.reloadPlatformCredentials('discord');

      expect(closeSpy).toHaveBeenCalled();
      expect(firstSocket.readyState).toBe(3);
      // A fresh socket was created for the rotated token.
      expect(FakeSocket.instances.length).toBe(2);
    } finally {
      await runtime.stop();
      store.cleanup();
      delete process.env['DISCORD_BOT_TOKEN'];
    }
  });

  it('tears the adapter down when the credential is cleared', async () => {
    const { runtime, store } = buildRuntime({
      TEST_ONEBOT_TOKEN: 'onebot-secret',
      DISCORD_BOT_TOKEN: 'test-bot-token-value',
    });
    try {
      await runtime.start();
      expect(runtime.getPlatformConnection('discord').connection).not.toBe('unconfigured');

      runtime.clearCredentialValue('DISCORD_BOT_TOKEN');
      await runtime.reloadPlatformCredentials('discord');

      const view = runtime.getPlatformView('discord');
      expect(view.credentials[0]?.state).toBe('missing');
      expect(view.credentials[0]?.masked).toBeNull();
      expect(runtime.getPlatformConnection('discord').connection).toBe('unconfigured');
    } finally {
      await runtime.stop();
      store.cleanup();
      delete process.env['DISCORD_BOT_TOKEN'];
    }
  });

  it('reloads QQ independently from Discord', async () => {
    const { runtime, store } = buildRuntime({
      TEST_ONEBOT_TOKEN: 'onebot-secret',
      DISCORD_BOT_TOKEN: 'test-bot-token-value',
    });
    try {
      await runtime.start();
      // The only socket so far belongs to Discord (QQ has no credentials yet).
      expect(FakeSocket.instances.length).toBe(1);
      const discordSocket = FakeSocket.latest();
      const discordCloseSpy = vi.spyOn(discordSocket, 'close');

      runtime.applyCredentialValue('QQ_APP_ID', '102030405');
      runtime.applyCredentialValue('QQ_APP_SECRET', 'test-app-secret-value');
      await runtime.reloadPlatformCredentials('qq-official');

      const qq = runtime.getPlatformView('qq-official');
      expect(qq.credentials.map((credential) => credential.state)).toEqual([
        'configured',
        'configured',
      ]);
      // A QQ-only reload must not touch the Discord websocket.
      expect(discordCloseSpy).not.toHaveBeenCalled();
      expect(discordSocket.readyState).not.toBe(3);
    } finally {
      await runtime.stop();
      store.cleanup();
      delete process.env['DISCORD_BOT_TOKEN'];
      delete process.env['QQ_APP_ID'];
      delete process.env['QQ_APP_SECRET'];
    }
  });

  it('marks credentials read-only when console writes are disabled', async () => {
    const { runtime, store } = buildRuntime({
      TEST_ONEBOT_TOKEN: 'onebot-secret',
      DISCORD_BOT_TOKEN: 'test-bot-token-value',
    });
    try {
      // createTestConfig keeps the default allowConsoleWrite=false.
      const view = runtime.getPlatformView('discord');
      expect(view.credentials[0]?.writable).toBe(false);
      expect(view.credentials[0]?.state).toBe('configured');
    } finally {
      await runtime.stop();
      store.cleanup();
      delete process.env['DISCORD_BOT_TOKEN'];
    }
  });
});
