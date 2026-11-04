import type {
  CapabilityFlag,
  ConnectionState,
  ConversationKind,
  DeliveryStatus,
  MessageKind,
  Platform,
  RateLimitScope,
  ReplyPolicyMode,
  RuleDecision,
} from '../api/types';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const DEFAULT_PAGE_SIZE = 20;
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
export const DASHBOARD_REFRESH_MS = 10_000;

export const PLATFORM_OPTIONS: ReadonlyArray<{ value: Platform; label: string }> = [
  { value: 'discord', label: 'Discord' },
  { value: 'qq-official', label: 'QQ 官方机器人' },
];

export const PLATFORM_LABELS: Record<Platform, string> = {
  discord: 'Discord',
  'qq-official': 'QQ 官方机器人',
};

export const PLATFORM_SHORT_LABELS: Record<Platform, string> = {
  discord: 'Discord',
  'qq-official': 'QQ',
};

export const CONVERSATION_KIND_LABELS: Record<ConversationKind, string> = {
  private: '私聊',
  group: '群聊',
  channel: '频道',
};

export const CONVERSATION_KIND_OPTIONS: ReadonlyArray<{ value: ConversationKind; label: string }> =
  [
    { value: 'private', label: '私聊' },
    { value: 'group', label: '群聊' },
    { value: 'channel', label: '频道' },
  ];

export const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  disconnected: '已断开',
  error: '异常',
  disabled: '已停用',
  unconfigured: '未配置',
};

export const CONNECTION_STATE_TONES: Record<ConnectionState, BadgeTone> = {
  connected: 'success',
  connecting: 'info',
  reconnecting: 'info',
  disconnected: 'neutral',
  error: 'danger',
  disabled: 'neutral',
  unconfigured: 'warning',
};

export function connectionLabel(status: string): string {
  return (CONNECTION_STATE_LABELS as Record<string, string>)[status] ?? status;
}

export function connectionTone(status: string): BadgeTone {
  return (CONNECTION_STATE_TONES as Record<string, BadgeTone>)[status] ?? 'neutral';
}

export const CAPABILITY_FLAGS: readonly CapabilityFlag[] = [
  'privateReceive',
  'privateReply',
  'privateProactiveSend',
  'groupReceive',
  'groupMentionReceive',
  'groupReply',
  'groupProactiveSend',
  'broadcast',
];

export const CAPABILITY_LABELS: Record<CapabilityFlag, string> = {
  privateReceive: '接收私聊',
  privateReply: '回复私聊',
  privateProactiveSend: '主动私聊',
  groupReceive: '接收全部群消息',
  groupMentionReceive: '接收 @ 群消息',
  groupReply: '回复群聊',
  groupProactiveSend: '主动群消息',
  broadcast: '群发广播',
};

export const REPLY_POLICY_MODE_OPTIONS: ReadonlyArray<{ value: ReplyPolicyMode; label: string }> = [
  { value: 'always', label: '始终回复' },
  { value: 'mention_only', label: '只有 @机器人时回复' },
  { value: 'private_only', label: '只回复私聊' },
  { value: 'whitelist', label: '仅白名单回复' },
  { value: 'disabled', label: '暂停自动回复' },
];

export const REPLY_POLICY_MODE_LABELS: Record<ReplyPolicyMode, string> = {
  always: '始终回复',
  mention_only: '只有 @机器人时回复',
  private_only: '只回复私聊',
  whitelist: '仅白名单回复',
  disabled: '暂停自动回复',
};

export const RATE_LIMIT_SCOPE_OPTIONS: ReadonlyArray<{ value: RateLimitScope; label: string }> = [
  { value: 'user', label: '按用户' },
  { value: 'conversation', label: '按会话' },
  { value: 'platform', label: '按平台' },
  { value: 'global', label: '全局' },
];

export const MESSAGE_KIND_OPTIONS: ReadonlyArray<{ value: MessageKind; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'file', label: '文件' },
  { value: 'mixed', label: '混合' },
];

export const WEEKDAY_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
];

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  ignored: '已忽略',
  blocked: '已拦截',
  queued: '排队中',
  sending: '发送中',
  sent: '已发送',
  failed: '失败',
  dead: '死信',
};

export const DELIVERY_STATUS_TONES: Record<DeliveryStatus, BadgeTone> = {
  ignored: 'neutral',
  blocked: 'warning',
  queued: 'info',
  sending: 'info',
  sent: 'success',
  failed: 'danger',
  dead: 'danger',
};

export function deliveryStatusLabel(status: string): string {
  return (DELIVERY_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function deliveryStatusTone(status: string): BadgeTone {
  return (DELIVERY_STATUS_TONES as Record<string, BadgeTone>)[status] ?? 'neutral';
}

export const QUEUE_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'sending', label: '发送中' },
  { value: 'failed', label: '失败待重试' },
  { value: 'dead', label: '死信' },
];

export const RULE_DECISION_LABELS: Record<RuleDecision, string> = {
  reply: '回复',
  ignore: '忽略',
  blocked: '拦截',
};

export const RULE_DECISION_TONES: Record<RuleDecision, BadgeTone> = {
  reply: 'success',
  ignore: 'neutral',
  blocked: 'danger',
};

export function ruleDecisionLabel(decision: string): string {
  return (RULE_DECISION_LABELS as Record<string, string>)[decision] ?? decision;
}

export function ruleDecisionTone(decision: string): BadgeTone {
  return (RULE_DECISION_TONES as Record<string, BadgeTone>)[decision] ?? 'neutral';
}

export const LOG_LEVEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部级别' },
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
];

export function logLevelTone(level: string): BadgeTone {
  switch (level.toLowerCase()) {
    case 'error':
      return 'danger';
    case 'warn':
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    case 'debug':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function platformLabel(platform: string): string {
  return (PLATFORM_LABELS as Record<string, string>)[platform] ?? platform;
}

export function conversationKindLabel(kind: string): string {
  return (CONVERSATION_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}
