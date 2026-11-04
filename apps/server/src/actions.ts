import {
  BridgeError,
  ONEBOT_PROTOCOL_VERSION,
  type ConversationKind,
  type OneBotActionResponse,
  type OneBotGroupInfo,
  type OneBotGroupMemberInfo,
  type OneBotLoginInfo,
  type OneBotSegment,
  type OneBotStatusInfo,
  type OneBotStrangerInfo,
  type OneBotVersionInfo,
  type Platform,
  type UnifiedMessageEvent,
  type UnifiedSegment,
} from '@omni-relay/shared-types';
import { onebotSegmentsToUnified, parseCqString, truncate } from '@omni-relay/core';
import type { ActionContext, ActionHandlerResult, ActionRegistry } from '@omni-relay/onebot';

import type { BridgeRuntime } from './runtime.js';
import { APP_NAME, APP_VERSION, ONEBOT_IMPLEMENTATION, ONEBOT_NICKNAME } from './version.js';

/**
 * Registers the OneBot 11 action surface.
 *
 * `send_*` actions are never executed inline: they pass the capability and
 * rate-limit gates and are persisted in the outbox, then acknowledged
 * asynchronously (`status: "async"`, retcode 1) so that a restart never loses a
 * pending reply.
 */
export function registerActions(registry: ActionRegistry, runtime: BridgeRuntime): void {
  const logger = runtime.getLogger();

  registry.register('get_login_info', async () => {
    const info: OneBotLoginInfo = {
      user_id: runtime.getSelfId(),
      nickname: ONEBOT_NICKNAME,
    };
    return { data: info };
  });

  registry.register('get_status', async () => {
    const status: OneBotStatusInfo = {
      online: runtime.onebot.getStatus().connected,
      good: true,
    };
    return { data: status };
  });

  registry.register('get_version_info', async () => {
    const info: OneBotVersionInfo = {
      app_name: APP_NAME,
      app_version: APP_VERSION,
      protocol_version: ONEBOT_PROTOCOL_VERSION,
      app_full_name: `${APP_NAME} ${APP_VERSION} (${ONEBOT_IMPLEMENTATION})`,
    };
    return { data: info };
  });

  registry.register('get_group_list', async () => {
    const groups = listKnownGroups(runtime);
    return { data: groups };
  });

  registry.register('get_group_info', async (params) => {
    const groupId = requireInteger(params, 'group_id');
    const mapping = runtime.storage.ids.getByOneBotId('group', groupId);
    if (!mapping) {
      throw new BridgeError({
        code: 'not_found',
        message: `group_not_found:${groupId}`,
        retryable: false,
      });
    }
    const info: OneBotGroupInfo = {
      group_id: mapping.onebotId,
      group_name: mapping.displayName ?? mapping.nativeId,
    };
    return { data: info };
  });

  registry.register('get_group_member_info', async (params) => {
    const groupId = requireInteger(params, 'group_id');
    const userId = requireInteger(params, 'user_id');
    const group = runtime.storage.ids.getByOneBotId('group', groupId);
    const user = runtime.storage.ids.getByOneBotId('user', userId);
    if (!group || !user) {
      throw new BridgeError({
        code: 'not_found',
        message: `member_not_found:${groupId}/${userId}`,
        retryable: false,
      });
    }
    const info: OneBotGroupMemberInfo = {
      group_id: group.onebotId,
      user_id: user.onebotId,
      nickname: user.displayName ?? user.nativeId,
      card: '',
      role: 'member',
    };
    return { data: info };
  });

  registry.register('get_stranger_info', async (params) => {
    const userId = requireInteger(params, 'user_id');
    const mapping = runtime.storage.ids.getByOneBotId('user', userId);
    if (!mapping) {
      throw new BridgeError({
        code: 'not_found',
        message: `user_not_found:${userId}`,
        retryable: false,
      });
    }
    const info: OneBotStrangerInfo = {
      user_id: mapping.onebotId,
      nickname: mapping.displayName ?? mapping.nativeId,
      sex: 'unknown',
      age: 0,
    };
    return { data: info };
  });

  registry.register('send_msg', async (params, context) => {
    const explicitType = optionalString(params['message_type']);
    const inferredType =
      explicitType === 'group' || explicitType === 'private'
        ? explicitType
        : params['group_id'] !== undefined
          ? 'group'
          : 'private';
    return sendMessage(runtime, inferredType, params, context);
  });

  registry.register('send_private_msg', async (params, context) =>
    sendMessage(runtime, 'private', params, context),
  );

  registry.register('send_group_msg', async (params, context) =>
    sendMessage(runtime, 'group', params, context),
  );

  logger.info('onebot actions registered', {
    event: 'onebot.actions',
    actions: registry.list().length,
  });
}

function listKnownGroups(runtime: BridgeRuntime): OneBotGroupInfo[] {
  const groups: OneBotGroupInfo[] = [];
  for (const nativeKind of ['group', 'channel'] as const) {
    const page = runtime.storage.ids.list({ nativeKind, page: 1, pageSize: 200 });
    for (const mapping of page.items) {
      groups.push({
        group_id: mapping.onebotId,
        group_name: mapping.displayName ?? mapping.nativeId,
      });
    }
  }
  return groups;
}

async function sendMessage(
  runtime: BridgeRuntime,
  kind: 'private' | 'group',
  params: Record<string, unknown>,
  context: ActionContext,
): Promise<ActionHandlerResult> {
  const logger = runtime.getLogger();
  const targetOneBotId = requireInteger(params, kind === 'private' ? 'user_id' : 'group_id');
  const mapping =
    kind === 'private'
      ? runtime.storage.ids.getByOneBotId('user', targetOneBotId)
      : runtime.storage.ids.getByOneBotId('group', targetOneBotId);

  if (!mapping) {
    throw new BridgeError({
      code: 'not_found',
      message: `unknown_${kind === 'private' ? 'user' : 'group'}:${targetOneBotId}`,
      retryable: false,
    });
  }

  const platform = mapping.platform;
  if (!runtime.isPlatformEnabled(platform)) {
    throw new BridgeError({
      code: 'platform_unavailable',
      message: `platform_disabled:${platform}`,
      retryable: false,
    });
  }

  const conversationKind: ConversationKind =
    kind === 'private' ? 'private' : platform === 'discord' ? 'channel' : 'group';

  const rawMessage = params['message'] ?? params['raw_message'];
  const segments = parseMessageSegments(rawMessage, platform, runtime);
  if (segments.length === 0) {
    throw new BridgeError({
      code: 'invalid_config',
      message: 'empty_message',
      retryable: false,
    });
  }

  const rateLimit = runtime.getActionRateLimit();
  const decision = runtime.storage.rateLimits.consume(
    { scope: 'platform', scopeId: platform },
    rateLimit,
    new Date(),
  );
  if (!decision.allowed) {
    throw new BridgeError({
      code: 'rate_limited',
      message: `action_rate_limited:${platform}`,
      retryable: true,
      retryAfterMs: decision.retryAfterMs,
    });
  }

  const replyTarget = runtime.getReplyTarget(platform, mapping.nativeId);
  const proactive = replyTarget.nativeMessageId === null;

  const now = new Date();
  const pseudoEvent: UnifiedMessageEvent = {
    eventId: runtime.newActionEventId(),
    platform,
    conversation: {
      kind: conversationKind,
      nativeId: mapping.nativeId,
      ...(mapping.displayName ? { displayName: mapping.displayName } : {}),
    },
    sender: { nativeId: 'onebot' },
    message: segments,
    timestamp: now.toISOString(),
    mentionsBot: false,
    meta: {
      origin: 'onebot',
      bridgeMessageId: runtime.newBridgeMessageId(platform),
      createdAt: now.toISOString(),
    },
  };

  const planner = runtime.getPlanner(platform);
  const plan = planner.plan({
    event: pseudoEvent,
    rule: null,
    evaluation: {
      matched: true,
      matchedRules: [],
      decision: 'reply',
      reason: 'onebot_action',
      status: 'queued',
    },
    segments,
    replyToNativeMessageId: replyTarget.nativeMessageId,
    proactive,
  });

  if (plan.status === 'queued' && plan.outboxId) {
    logger.info('onebot action queued for delivery', {
      event: 'action.send.queued',
      platform,
      action: context.action,
      outboxId: plan.outboxId,
      proactive,
      preview: truncate(summarize(segments), 120),
    });
    return { status: 'async', data: { message_id: plan.outboxId } };
  }

  if (plan.status === 'blocked') {
    if (plan.reason === 'rate_limited') {
      throw new BridgeError({
        code: 'rate_limited',
        message: 'delivery_rate_limited',
        retryable: true,
      });
    }
    throw new BridgeError({
      code: 'capability_unsupported',
      message: plan.reason,
      retryable: false,
    });
  }

  if (plan.status === 'failed') {
    throw new BridgeError({
      code: 'platform_rejected',
      message: plan.reason,
      retryable: false,
    });
  }

  throw new BridgeError({
    code: 'forbidden',
    message: plan.reason,
    retryable: false,
  });
}

function parseMessageSegments(
  raw: unknown,
  platform: Platform,
  runtime: BridgeRuntime,
): UnifiedSegment[] {
  const resolver = {
    toNativeUserId: (onebotId: number): string | null => {
      const mapping = runtime.storage.ids.getByOneBotId('user', onebotId);
      if (!mapping || mapping.platform !== platform) {
        return null;
      }
      return mapping.nativeId;
    },
  };

  if (Array.isArray(raw)) {
    return onebotSegmentsToUnified(raw as OneBotSegment[], resolver).segments;
  }
  if (typeof raw === 'string') {
    return onebotSegmentsToUnified(parseCqString(raw), resolver).segments;
  }
  return [];
}

function summarize(segments: readonly UnifiedSegment[]): string {
  return segments
    .map((segment) => {
      switch (segment.type) {
        case 'text':
          return segment.text;
        case 'mention':
          return `@${segment.userId}`;
        case 'image':
          return '[image]';
        case 'file':
          return `[file:${segment.filename}]`;
        case 'reply':
          return '[reply]';
        default:
          return '';
      }
    })
    .join('');
}

function requireInteger(params: Record<string, unknown>, key: string): number {
  const raw = params[key];
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BridgeError({
      code: 'invalid_config',
      message: `missing_or_invalid_param:${key}`,
      retryable: false,
    });
  }
  return Math.trunc(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export type { OneBotActionResponse };
