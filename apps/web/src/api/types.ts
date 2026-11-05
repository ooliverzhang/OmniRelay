/**
 * API DTOs mirrored from `packages/shared-types/src/api.ts`.
 *
 * The web app deliberately keeps its own copy instead of importing the shared
 * package so that it can be type-checked and built on its own.
 */

export type Platform = 'discord' | 'qq-official';

export type ConversationKind = 'private' | 'group' | 'channel';

export type ConnectionState =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'disconnected'
  | 'error'
  | 'disabled'
  | 'unconfigured';

export type CredentialState = 'configured' | 'missing';

export type DeliveryStatus =
  'ignored' | 'blocked' | 'queued' | 'sending' | 'sent' | 'failed' | 'dead';

export type MessageStatus = 'ignored' | 'blocked' | 'queued' | 'sent' | 'failed';

export type RuleDecision = 'reply' | 'ignore' | 'blocked';

export type ReplyPolicyMode = 'always' | 'mention_only' | 'private_only' | 'whitelist' | 'disabled';

export type RateLimitScope = 'user' | 'conversation' | 'platform' | 'global';

export type MessageKind = 'text' | 'image' | 'file' | 'mixed';

export type NativeIdKind = 'user' | 'group' | 'channel';

export type OneBotIdKind = 'user' | 'group';

export type CapabilityFlag =
  | 'privateReceive'
  | 'privateReply'
  | 'privateProactiveSend'
  | 'groupReceive'
  | 'groupMentionReceive'
  | 'groupReply'
  | 'groupProactiveSend'
  | 'broadcast';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SessionView {
  authenticated: boolean;
  authRequired: boolean;
  username: string | null;
  expiresAt: string | null;
}

export interface LoginRequest {
  username?: string;
  password: string;
}

export interface PlatformCapabilities {
  privateReceive: boolean;
  privateReply: boolean;
  privateProactiveSend: boolean;
  groupReceive: boolean;
  groupMentionReceive: boolean;
  groupReply: boolean;
  groupProactiveSend: boolean;
  broadcast: boolean;
}

export interface PlatformCredentialView {
  /** Human readable credential name, e.g. "Bot Token". */
  name: string;
  /** Environment variable that must hold the value. */
  env: string;
  state: CredentialState;
}

export interface PlatformSettingsView {
  guildAllowlist: string[];
  channelAllowlist: string[];
  groupAllowlist: string[];
  allowProactivePrivate: boolean;
  allowProactiveGroup: boolean;
  receiveAllGroupMessages: boolean;
  messageContentIntent: boolean;
}

export interface PlatformView {
  platform: Platform;
  label: string;
  enabled: boolean;
  connection: ConnectionState;
  detail: string | null;
  lastEventAt: string | null;
  credentials: PlatformCredentialView[];
  capabilities: PlatformCapabilities;
  settings: PlatformSettingsView;
}

export interface PlatformUpdateRequest {
  enabled?: boolean;
  settings?: Partial<PlatformSettingsView>;
}

export interface PlatformActionResponse {
  ok: boolean;
  message: string;
  connection?: ConnectionState;
}

export interface PlatformCount {
  platform: Platform;
  count: number;
}

export interface MessageTrendPoint {
  /** ISO-8601 start of the bucket (hourly). */
  bucket: string;
  total: number;
  byPlatform: Record<string, number>;
}

export interface RecentErrorView {
  id: string;
  time: string;
  level: 'warn' | 'error';
  code: string;
  message: string;
}

export interface OneBotStatusView {
  connected: boolean;
  clients: number;
  lastEventAt: string | null;
  pendingActions: number;
}

export interface QueueStatsView {
  queued: number;
  sending: number;
  retrying: number;
  dead: number;
  sent24h: number;
  failed24h: number;
}

export interface DashboardSummary {
  generatedAt: string;
  uptimeSeconds: number;
  version: string;
  platforms: Array<{
    platform: Platform;
    label: string;
    enabled: boolean;
    connection: ConnectionState;
    lastEventAt: string | null;
  }>;
  activePlatforms: number;
  onebot: OneBotStatusView;
  queue: QueueStatsView;
  messages: {
    last24h: number;
    trend: MessageTrendPoint[];
    byPlatform: PlatformCount[];
  };
  rules: {
    total: number;
    enabled: number;
  };
  replyPolicy: {
    defaultMode: ReplyPolicyMode;
  };
  recentErrors: RecentErrorView[];
}

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
  maxResponseSegments?: number;
}

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

export type RuleView = MessageRule;

export interface RuleUpsertRequest {
  name: string;
  enabled?: boolean;
  priority?: number;
  platforms: Platform[];
  conversationKinds: ConversationKind[];
  groupIds?: string[];
  channelIds?: string[];
  userIds?: string[];
  trigger?: TriggerConfig;
  response?: ResponsePolicy;
  rateLimit?: RateLimitConfig;
  schedule?: ScheduleConfig;
}

export interface RuleToggleRequest {
  enabled: boolean;
}

export interface RuleReorderRequest {
  orderedIds: string[];
}

export interface RuleTestRequest {
  platform: Platform;
  conversationKind: ConversationKind;
  conversationId?: string;
  userId?: string;
  text: string;
  mention: boolean;
  replyToBot?: boolean;
  timestamp?: string;
  hasImage?: boolean;
  hasFile?: boolean;
  /** Limit evaluation to a subset of rules. */
  ruleIds?: string[];
}

export interface RuleTestMatchedRule {
  id: string;
  name: string;
  matched: boolean;
  reason: string;
}

export interface RuleEvaluationResult {
  matched: boolean;
  matchedRules: string[];
  decision: RuleDecision;
  reason: string;
  status: MessageStatus;
}

export interface RuleTestResponse extends RuleEvaluationResult {
  explanation: string;
  appliedPolicyMode: ReplyPolicyMode;
  evaluatedRules: RuleTestMatchedRule[];
}

export interface ConversationRow {
  platform: Platform;
  conversationKind: ConversationKind;
  conversationNativeId: string;
  displayName: string | null;
  onebotGroupId: number | null;
  messageCount: number;
  lastMessageAt: string;
}

export interface MessageRow {
  id: string;
  bridgeMessageId: string;
  platform: Platform;
  conversationKind: ConversationKind;
  conversationNativeId: string;
  senderNativeId: string;
  senderDisplayName: string | null;
  onebotUserId: number | null;
  onebotGroupId: number | null;
  text: string;
  segmentTypes: string[];
  status: MessageStatus | DeliveryStatus;
  reason: string | null;
  matchedRuleId: string | null;
  nativeMessageId: string | null;
  createdAt: string;
}

export interface IdentityRow {
  platform: Platform;
  nativeKind: NativeIdKind;
  nativeId: string;
  onebotKind: OneBotIdKind;
  onebotId: number;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueRow {
  id: string;
  platform: Platform;
  conversationKind: ConversationKind;
  conversationNativeId: string;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  text: string;
  proactive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeadLetterRow {
  id: string;
  outboxId: string;
  platform: Platform;
  conversationKind: ConversationKind;
  conversationNativeId: string;
  reasonCode: string;
  reasonMessage: string;
  text: string;
  attempts: number;
  failedAt: string;
}

export interface LogRow {
  id: string;
  time: string;
  level: string;
  msg: string;
  platform: string | null;
  event: string | null;
  context: Record<string, unknown> | null;
}

export interface ReplyPolicyConfig {
  defaultMode: ReplyPolicyMode;
  allowPrivateWithoutMention: boolean;
  allowGroupWithoutMention: boolean;
  allowChannelWithoutMention: boolean;
  whitelistUserIds: string[];
  whitelistGroupIds: string[];
}

export interface RulesEngineConfig {
  enabled: boolean;
  defaultAction: 'ignore';
  stopOnFirstMatch: boolean;
}

export interface RetryPolicyConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface SettingsView {
  version: string;
  nodeVersion: string;
  paths: {
    dataDir: string;
    sqlitePath: string;
  };
  replyPolicy: ReplyPolicyConfig;
  rules: RulesEngineConfig;
  retry: RetryPolicyConfig;
  onebot: {
    websocketPath: string;
    accessTokenConfigured: boolean;
    actionTimeoutMs: number;
    maxPendingActions: number;
  };
  web: {
    adminAuth: boolean;
    sessionTtlSeconds: number;
  };
  logging: {
    level: string;
    pretty: boolean;
  };
}

export interface SettingsUpdateRequest {
  replyPolicy?: Partial<ReplyPolicyConfig>;
  rules?: Partial<RulesEngineConfig>;
  retry?: Partial<RetryPolicyConfig>;
}

/** Response of the retry endpoints. */
export interface RetryResponse {
  ok: boolean;
  message: string;
}

export interface OkResponse {
  ok: true;
}
