import type { ConversationKind, Platform } from './platform.js';

/**
 * Global reply policy. A rule may override the global `defaultMode` but never
 * the platform capability matrix.
 */
export const REPLY_POLICY_MODES = [
  'always',
  'mention_only',
  'private_only',
  'whitelist',
  'disabled',
] as const;

export type ReplyPolicyMode = (typeof REPLY_POLICY_MODES)[number];

export const REPLY_POLICY_LABELS: Record<ReplyPolicyMode, string> = {
  always: '始终回复',
  mention_only: '只有 @机器人时回复',
  private_only: '只回复私聊',
  whitelist: '仅白名单回复',
  disabled: '暂停自动回复',
};

export interface ReplyPolicyConfig {
  defaultMode: ReplyPolicyMode;
  allowPrivateWithoutMention: boolean;
  allowGroupWithoutMention: boolean;
  allowChannelWithoutMention: boolean;
  whitelistUserIds: string[];
  whitelistGroupIds: string[];
}

export const DEFAULT_REPLY_POLICY: ReplyPolicyConfig = {
  defaultMode: 'mention_only',
  allowPrivateWithoutMention: true,
  allowGroupWithoutMention: false,
  allowChannelWithoutMention: false,
  whitelistUserIds: [],
  whitelistGroupIds: [],
};

export type MessageKind = 'text' | 'image' | 'file' | 'mixed';

export interface TriggerConfig {
  requireMention?: boolean;
  requireReplyToBot?: boolean;
  textIncludes?: string[];
  textPrefix?: string;
  textRegex?: string;
  messageTypes?: MessageKind[];
  userAllowlist?: string[];
  groupAllowlist?: string[];
  channelAllowlist?: string[];
  privateOnly?: boolean;
  groupOnly?: boolean;
  /** Ignore messages authored by other bots (default true). */
  ignoreBots?: boolean;
}

export interface ResponsePolicy {
  enabled: boolean;
  allowProactive: boolean;
  allowPrivate: boolean;
  allowGroup: boolean;
  allowChannel: boolean;
  /** When set, requests that would exceed the segment budget are rejected. */
  maxResponseSegments?: number;
}

export const DEFAULT_RESPONSE_POLICY: ResponsePolicy = {
  enabled: true,
  allowProactive: false,
  allowPrivate: true,
  allowGroup: true,
  allowChannel: true,
};

export type RateLimitScope = 'user' | 'conversation' | 'platform' | 'global';

export interface RateLimitConfig {
  maxMessages: number;
  windowSeconds: number;
  scope: RateLimitScope;
}

export interface ScheduleConfig {
  timezone?: string;
  /** ISO weekday numbers, 1 = Monday ... 7 = Sunday. */
  weekdays?: number[];
  /** HH:mm in the configured timezone. */
  startTime?: string;
  endTime?: string;
}

export interface MessageRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  platforms: Platform[];
  conversationKinds: ConversationKind[];
  groupIds: string[];
  channelIds: string[];
  userIds: string[];
  trigger: TriggerConfig;
  response: ResponsePolicy;
  rateLimit?: RateLimitConfig;
  schedule?: ScheduleConfig;
  createdAt: string;
  updatedAt: string;
}

/** Decision returned by the rule engine. */
export type RuleDecision = 'reply' | 'ignore' | 'blocked';

/** Delivery-oriented status, see the specification's status vocabulary. */
export type MessageStatus = 'ignored' | 'blocked' | 'queued' | 'sent' | 'failed';

export interface RuleEvaluationResult {
  matched: boolean;
  matchedRules: string[];
  decision: RuleDecision;
  /** Machine readable reason, e.g. `mention_required_and_present`. */
  reason: string;
  status: MessageStatus;
}

/** Pure input for the offline rule tester. */
export interface RuleTestInput {
  platform: Platform;
  conversationKind: ConversationKind;
  conversationId: string;
  userId: string;
  text: string;
  mention: boolean;
  replyToBot?: boolean;
  timestamp?: string;
  hasImage?: boolean;
  hasFile?: boolean;
}

export interface RuleTestResult extends RuleEvaluationResult {
  /** Human readable explanation for the console. */
  explanation: string;
  appliedPolicyMode: ReplyPolicyMode;
}

export interface RulesEngineConfig {
  enabled: boolean;
  defaultAction: 'ignore';
  stopOnFirstMatch: boolean;
}

export const DEFAULT_RULES_ENGINE_CONFIG: RulesEngineConfig = {
  enabled: true,
  defaultAction: 'ignore',
  stopOnFirstMatch: true,
};
