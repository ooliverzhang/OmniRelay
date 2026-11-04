import type {
  MessageRule,
  PlatformCapabilities,
  ReplyPolicyConfig,
  RulesEngineConfig,
  UnifiedMessageEvent,
} from '@omni-relay/shared-types';
import {
  DEFAULT_REPLY_POLICY,
  DEFAULT_RESPONSE_POLICY,
  DEFAULT_RULES_ENGINE_CONFIG,
} from '@omni-relay/shared-types';

export const ALL_CAPABILITIES: PlatformCapabilities = {
  privateReceive: true,
  privateReply: true,
  privateProactiveSend: true,
  groupReceive: true,
  groupMentionReceive: true,
  groupReply: true,
  groupProactiveSend: true,
  broadcast: true,
};

export function makeCapabilities(
  overrides: Partial<PlatformCapabilities> = {},
): PlatformCapabilities {
  return { ...ALL_CAPABILITIES, ...overrides };
}

export function makePolicy(overrides: Partial<ReplyPolicyConfig> = {}): ReplyPolicyConfig {
  return { ...DEFAULT_REPLY_POLICY, ...overrides };
}

export function makeEngine(overrides: Partial<RulesEngineConfig> = {}): RulesEngineConfig {
  return { ...DEFAULT_RULES_ENGINE_CONFIG, ...overrides };
}

export function makeRule(overrides: Partial<MessageRule> = {}): MessageRule {
  return {
    id: 'rule-1',
    name: 'Rule One',
    enabled: true,
    priority: 0,
    platforms: ['discord', 'qq-official'],
    conversationKinds: ['private', 'group', 'channel'],
    groupIds: [],
    channelIds: [],
    userIds: [],
    trigger: {},
    response: { ...DEFAULT_RESPONSE_POLICY },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<UnifiedMessageEvent> = {}): UnifiedMessageEvent {
  return {
    eventId: 'evt_test',
    platform: 'discord',
    conversation: { kind: 'group', nativeId: 'channel-1' },
    sender: { nativeId: 'user-1' },
    message: [{ type: 'text', text: 'hello world' }],
    timestamp: '2026-01-02T00:00:00.000Z',
    mentionsBot: false,
    meta: {
      origin: 'discord',
      bridgeMessageId: 'brg_test',
      nativeMessageId: 'native-1',
      createdAt: '2026-01-02T00:00:00.000Z',
    },
    ...overrides,
  };
}
