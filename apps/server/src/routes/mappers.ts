import {
  segmentsToPlainText,
  type ConversationRow,
  type DeadLetterRow,
  type DeadLetterRecord,
  type IdMapping,
  type IdentityRow,
  type LogRow,
  type MessageRow,
  type MessageRule,
  type OutboxRecord,
  type OutgoingMessage,
  type QueueRow,
  type RuleView,
} from '@omni-relay/shared-types';
import { truncate } from '@omni-relay/core';
import type {
  ConversationAggregateRow,
  LogEntryRow,
  MessageRecordRow,
} from '@omni-relay/storage';

export function toRuleView(rule: MessageRule): RuleView {
  return { ...rule };
}

export function summarizeOutgoing(payload: OutgoingMessage): string {
  const text = segmentsToPlainText(payload.segments);
  if (text.length > 0) {
    return truncate(text, 300);
  }
  const kinds = payload.segments.map((segment) => segment.type).join(',');
  return kinds.length > 0 ? `[${kinds}]` : '';
}

export function toQueueRow(record: OutboxRecord): QueueRow {
  return {
    id: record.id,
    platform: record.platform,
    conversationKind: record.conversationKind,
    conversationNativeId: record.conversationNativeId,
    status: record.status,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    nextAttemptAt: record.nextAttemptAt,
    lastErrorCode: record.lastError?.code ?? null,
    lastErrorMessage: record.lastError?.message ?? null,
    text: summarizeOutgoing(record.payload),
    proactive: record.payload.proactive,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toDeadLetterRow(record: DeadLetterRecord): DeadLetterRow {
  return {
    id: record.id,
    outboxId: record.outboxId,
    platform: record.platform,
    conversationKind: record.conversationKind,
    conversationNativeId: record.conversationNativeId,
    reasonCode: record.reasonCode,
    reasonMessage: record.reasonMessage,
    text: summarizeOutgoing(record.payload),
    attempts: record.attempts,
    failedAt: record.failedAt,
  };
}

export function toMessageRow(row: MessageRecordRow): MessageRow {
  return {
    id: row.id,
    bridgeMessageId: row.bridgeMessageId,
    platform: row.platform,
    conversationKind: row.conversationKind,
    conversationNativeId: row.conversationNativeId,
    senderNativeId: row.senderNativeId,
    senderDisplayName: row.senderDisplayName,
    onebotUserId: row.onebotUserId,
    onebotGroupId: row.onebotGroupId,
    text: row.text,
    segmentTypes: row.segmentTypes,
    status: row.status as MessageRow['status'],
    reason: row.reason,
    matchedRuleId: row.matchedRuleId,
    nativeMessageId: row.nativeMessageId,
    createdAt: row.createdAt,
  };
}

export function toIdentityRow(mapping: IdMapping): IdentityRow {
  return {
    platform: mapping.platform,
    nativeKind: mapping.nativeKind,
    nativeId: mapping.nativeId,
    onebotKind: mapping.onebotKind,
    onebotId: mapping.onebotId,
    displayName: mapping.displayName ?? null,
    createdAt: mapping.createdAt,
    updatedAt: mapping.updatedAt,
  };
}

export function toConversationRow(row: ConversationAggregateRow): ConversationRow {
  return {
    platform: row.platform,
    conversationKind: row.conversationKind,
    conversationNativeId: row.conversationNativeId,
    displayName: row.displayName,
    onebotGroupId: row.onebotGroupId,
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt,
  };
}

export function toLogRow(row: LogEntryRow): LogRow {
  return {
    id: row.id,
    time: row.time,
    level: row.level,
    msg: row.msg,
    platform: row.platform,
    event: row.event,
    context: row.context,
  };
}
