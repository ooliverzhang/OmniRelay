import type { FastifyInstance } from 'fastify';

import { isPlatform, type Platform } from '@omni-relay/shared-types';

import {
  CREDENTIAL_ENV_ALLOWLIST,
  isAllowedCredentialKey,
  isCredentialTarget,
  validateCredentialValue,
} from '../credential-policy.js';

import type { RouteContext, RouteGuard } from './context.js';

/**
 * Parses an `:env` path segment into a safe env key.
 *
 * Rejects anything that is not a plain `[A-Z0-9_]+` identifier so a crafted
 * URL cannot reach filesystem or shell interpolation.
 */
export function parseEnvKey(raw: string): string | null {
  const key = raw.trim();
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) {
    return null;
  }
  return key;
}

interface BridgeRuntimeLike {
  getPlatformView(platform: Platform): {
    credentials: Array<{ env: string; state: string; writable: boolean; masked: string | null }>;
  };
  reloadPlatformCredentials(platform: Platform): Promise<void>;
}

/** Credential management routes (console-configured `.env` values). */
export async function registerCredentialRoutes(
  app: FastifyInstance,
  context: RouteContext,
  guard: RouteGuard,
): Promise<void> {
  const store = context.credentials;
  const runtime = context.runtime as unknown as BridgeRuntimeLike;

  const denyWhenDisabled = (): { code: number; body: unknown } | null => {
    if (context.config.credentials.allowConsoleWrite) {
      return null;
    }
    return {
      code: 403,
      body: {
        error: {
          code: 'credential_write_disabled',
          message: '控制台写入未开启：请在 config.yaml 设置 credentials.allow_console_write: true',
        },
      },
    };
  };

  /** PUT /api/platforms/:platform/credentials */
  app.put<{ Params: { platform: string }; Body: { values?: Record<string, unknown> } }>(
    '/api/platforms/:platform/credentials',
    { preHandler: guard },
    async (request, reply) => {
      const target = request.params.platform;
      if (!isCredentialTarget(target)) {
        reply.code(400);
        return { error: { code: 'unsupported_platform', message: `不支持的平台：${target}` } };
      }

      const blocked = denyWhenDisabled();
      if (blocked) {
        reply.code(blocked.code);
        return blocked.body;
      }

      const values = request.body?.values;
      if (typeof values !== 'object' || values === null || Array.isArray(values)) {
        reply.code(400);
        return { error: { code: 'invalid_body', message: '请求体必须包含 values 对象' } };
      }

      const entries = Object.entries(values);
      if (entries.length === 0) {
        reply.code(400);
        return { error: { code: 'invalid_body', message: 'values 不能为空' } };
      }

      const updates: Array<{ key: string; value: string }> = [];
      for (const [key, rawValue] of entries) {
        if (!isAllowedCredentialKey(target, key)) {
          reply.code(400);
          return {
            error: {
              code: 'invalid_credential_key',
              message: `${target} 只允许写入：${CREDENTIAL_ENV_ALLOWLIST[target].join(', ')}`,
            },
          };
        }
        const validated = validateCredentialValue(rawValue);
        if (!validated.ok || validated.value === null) {
          reply.code(400);
          return {
            error: {
              code: 'invalid_credential_value',
              message: `凭据值不合法（${validated.reason ?? 'unknown'}）`,
            },
          };
        }
        updates.push({ key, value: validated.value });
      }

      const writtenKeys: string[] = [];
      try {
        for (const update of updates) {
          await store.set(update.key, update.value);
          context.runtime.applyCredentialValue(update.key, update.value);
          writtenKeys.push(update.key);
        }
      } catch (error) {
        context.logger.error('credential write failed', {
          event: 'platform.credential.write',
          platform: target,
          keys: writtenKeys,
          error: error instanceof Error ? error.message : 'unknown',
        });
        reply.code(500);
        return {
          error: { code: 'credential_write_failed', message: '凭据写入失败，请查看服务日志' },
        };
      }

      // Audit log: key names only, never values.
      context.logger.info('platform credential written', {
        event: 'platform.credential.write',
        platform: target,
        keys: writtenKeys,
      });

      if (isPlatform(target)) {
        await runtime.reloadPlatformCredentials(target);
        return context.runtime.getPlatformView(target);
      }

      return { ok: true, keys: writtenKeys };
    },
  );

  /** DELETE /api/platforms/:platform/credentials/:env */
  app.delete<{ Params: { platform: string; env: string } }>(
    '/api/platforms/:platform/credentials/:env',
    { preHandler: guard },
    async (request, reply) => {
      const target = request.params.platform;
      if (!isCredentialTarget(target)) {
        reply.code(400);
        return { error: { code: 'unsupported_platform', message: `不支持的平台：${target}` } };
      }

      const blocked = denyWhenDisabled();
      if (blocked) {
        reply.code(blocked.code);
        return blocked.body;
      }

      const key = parseEnvKey(request.params.env);
      if (key === null || !isAllowedCredentialKey(target, key)) {
        reply.code(400);
        return {
          error: {
            code: 'invalid_credential_key',
            message: `${target} 只允许清除：${CREDENTIAL_ENV_ALLOWLIST[target].join(', ')}`,
          },
        };
      }

      try {
        await store.set(key, '');
        context.runtime.clearCredentialValue(key);
      } catch (error) {
        context.logger.error('credential delete failed', {
          event: 'platform.credential.delete',
          platform: target,
          keys: [key],
          error: error instanceof Error ? error.message : 'unknown',
        });
        reply.code(500);
        return {
          error: { code: 'credential_delete_failed', message: '凭据清除失败，请查看服务日志' },
        };
      }

      context.logger.info('platform credential cleared', {
        event: 'platform.credential.delete',
        platform: target,
        keys: [key],
      });

      if (isPlatform(target)) {
        await runtime.reloadPlatformCredentials(target);
        return context.runtime.getPlatformView(target);
      }

      return { ok: true, keys: [key] };
    },
  );
}
