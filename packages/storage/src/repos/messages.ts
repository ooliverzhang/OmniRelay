import { randomUUID } from 'node:crypto';

import type {
  ConversationKind,
  MessageTrendPoint,
  Platform,
  PlatformCount,
  UnifiedSegment,
} from '@omni-relay/shared-types';

import type {
  ConversationAggregateRow,
  MessageRecordInput,
  MessageRecordRow,
  MessageRepo,
} from '../contracts.js';
import { normalizePage } from '../contracts.js';
import {
  likeClause,
  likePattern,
  parseJson,
  readChanges,
  readNumber,
  readNullableNumber,
  readNullableString,
  readString,
  rowOf,
  type SqlParam,
  type SqlRow,
  type StorageDb,
} from '../db.js';

const COLUMNS = `id, bridge_message_id, platform, conversation_kind, conversation_native_id,
  conversation_display_name, sender_native_id, sender_display_name, onebot_user_id,
  onebot_group_id, segments_json, segment_types_json, text, status, reason, matched_rule_id,
  native_message_id, created_at`;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTES_PER_DAY = 24 * 60;

function mapMessage(row: SqlRow): MessageRecordRow {
  return {
    id: readString(row, 'id'),
    bridgeMessageId: readString(row, 'bridge_message_id'),
    platform: readString(row, 'platform') as Platform,
    conversationKind: readString(row, 'conversation_kind') as ConversationKind,
    conversationNativeId: readString(row, 'conversation_native_id'),
    conversationDisplayName: readNullableString(row, 'conversation_display_name'),
    senderNativeId: readString(row, 'sender_native_id'),
    senderDisplayName: readNullableString(row, 'sender_display_name'),
    onebotUserId: readNullableNumber(row, 'onebot_user_id'),
    onebotGroupId: readNullableNumber(row, 'onebot_group_id'),
    segments: parseJson<UnifiedSegment[]>(row.segments_json, []),
    segmentTypes: parseJson<string[]>(row.segment_types_json, []),
    text: readString(row, 'text'),
    status: readString(row, 'status'),
    reason: readNullableString(row, 'reason'),
    matchedRuleId: readNullableString(row, 'matched_rule_id'),
    nativeMessageId: readNullableString(row, 'native_message_id'),
    createdAt: readString(row, 'created_at'),
  };
}

function mapConversation(row: SqlRow): ConversationAggregateRow {
  return {
    platform: readString(row, 'platform') as Platform,
    conversationKind: readString(row, 'conversation_kind') as ConversationKind,
    conversationNativeId: readString(row, 'conversation_native_id'),
    displayName: readNullableString(row, 'display_name'),
    onebotGroupId: readNullableNumber(row, 'onebot_group_id'),
    messageCount: readNumber(row, 'message_count'),
    lastMessageAt: readString(row, 'last_message_at'),
  };
}

function normalizeBucketMinutes(bucketMinutes: number | undefined): number {
  if (bucketMinutes === undefined || !Number.isFinite(bucketMinutes)) {
    return 60;
  }
  return Math.max(1, Math.floor(bucketMinutes));
}

export function createMessageRepo(db: StorageDb): MessageRepo {
  const get = (id: string): MessageRecordRow | null => {
    const row = rowOf(db.statement(`SELECT ${COLUMNS} FROM messages WHERE id = ?`).get(id));
    return row === null ? null : mapMessage(row);
  };

  return {
    record(input: MessageRecordInput): MessageRecordRow {
      const id = `msg_${randomUUID()}`;
      const createdAt = (input.createdAt ?? db.now()).toISOString();
      const segments = Array.isArray(input.segments) ? input.segments : [];
      const segmentTypes = segments.map((segment) => segment.type);
      db.statement(
        `INSERT INTO messages
          (id, bridge_message_id, platform, conversation_kind, conversation_native_id,
           conversation_display_name, sender_native_id, sender_display_name, onebot_user_id,
           onebot_group_id, segments_json, segment_types_json, text, status, reason,
           matched_rule_id, native_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.bridgeMessageId,
        input.platform,
        input.conversationKind,
        input.conversationNativeId,
        input.conversationDisplayName ?? null,
        input.senderNativeId,
        input.senderDisplayName ?? null,
        input.onebotUserId ?? null,
        input.onebotGroupId ?? null,
        JSON.stringify(segments),
        JSON.stringify(segmentTypes),
        input.text,
        input.status,
        input.reason ?? null,
        input.matchedRuleId ?? null,
        input.nativeMessageId ?? null,
        createdAt,
      );
      const created = get(id);
      if (created === null) {
        throw new Error(`Failed to read back the message row "${id}"`);
      }
      return created;
    },

    getByNativeMessageId(platform: Platform, nativeMessageId: string): MessageRecordRow | null {
      if (nativeMessageId.length === 0) {
        return null;
      }
      const row = rowOf(
        db
          .statement(
            `SELECT ${COLUMNS} FROM messages
             WHERE platform = ? AND native_message_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
          )
          .get(platform, nativeMessageId),
      );
      return row === null ? null : mapMessage(row);
    },

    getByBridgeMessageId(bridgeMessageId: string): MessageRecordRow | null {
      if (bridgeMessageId.length === 0) {
        return null;
      }
      const row = rowOf(
        db
          .statement(
            `SELECT ${COLUMNS} FROM messages
             WHERE bridge_message_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
          )
          .get(bridgeMessageId),
      );
      return row === null ? null : mapMessage(row);
    },

    list(query) {
      const conditions: string[] = [];
      const params: SqlParam[] = [];
      if (query.platform !== undefined) {
        conditions.push('platform = ?');
        params.push(query.platform);
      }
      if (query.conversationKind !== undefined) {
        conditions.push('conversation_kind = ?');
        params.push(query.conversationKind);
      }
      if (query.conversationNativeId !== undefined) {
        conditions.push('conversation_native_id = ?');
        params.push(query.conversationNativeId);
      }
      if (query.senderNativeId !== undefined) {
        conditions.push('sender_native_id = ?');
        params.push(query.senderNativeId);
      }
      if (query.status !== undefined) {
        conditions.push('status = ?');
        params.push(query.status);
      }
      const search = query.search?.trim().slice(0, 200);
      if (search !== undefined && search.length > 0) {
        conditions.push(likeClause('text'));
        params.push(likePattern(search));
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const { page, pageSize } = normalizePage(query);
      const totalRow = rowOf(
        db.statement(`SELECT COUNT(*) AS total FROM messages ${where}`).get(...params),
      );
      const rows = db
        .statement(
          `SELECT ${COLUMNS} FROM messages ${where}
           ORDER BY created_at DESC, id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (page - 1) * pageSize);
      return {
        items: rows.map((row) => mapMessage(rowOf(row) as SqlRow)),
        total: totalRow === null ? 0 : readNumber(totalRow, 'total'),
      };
    },

    conversations(query) {
      const conditions: string[] = [];
      const params: SqlParam[] = [];
      if (query.platform !== undefined) {
        conditions.push('m.platform = ?');
        params.push(query.platform);
      }
      const search = query.search?.trim().slice(0, 200);
      if (search !== undefined && search.length > 0) {
        conditions.push(
          `(${likeClause('m.conversation_native_id')} OR ${likeClause('m.conversation_display_name')})`,
        );
        const pattern = likePattern(search);
        params.push(pattern, pattern);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const { page, pageSize } = normalizePage(query);

      const totalRow = rowOf(
        db
          .statement(
            `SELECT COUNT(*) AS total FROM (
               SELECT 1 FROM messages m ${where}
               GROUP BY m.platform, m.conversation_kind, m.conversation_native_id
             )`,
          )
          .get(...params),
      );
      const rows = db
        .statement(
          `SELECT
             m.platform AS platform,
             m.conversation_kind AS conversation_kind,
             m.conversation_native_id AS conversation_native_id,
             COUNT(*) AS message_count,
             MAX(m.created_at) AS last_message_at,
             (SELECT m2.conversation_display_name FROM messages m2
                WHERE m2.platform = m.platform
                  AND m2.conversation_kind = m.conversation_kind
                  AND m2.conversation_native_id = m.conversation_native_id
                  AND m2.conversation_display_name IS NOT NULL
                ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1) AS display_name,
             (SELECT m3.onebot_group_id FROM messages m3
                WHERE m3.platform = m.platform
                  AND m3.conversation_kind = m.conversation_kind
                  AND m3.conversation_native_id = m.conversation_native_id
                  AND m3.onebot_group_id IS NOT NULL
                ORDER BY m3.created_at DESC, m3.id DESC LIMIT 1) AS onebot_group_id
           FROM messages m
           ${where}
           GROUP BY m.platform, m.conversation_kind, m.conversation_native_id
           ORDER BY last_message_at DESC, m.platform ASC, m.conversation_native_id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (page - 1) * pageSize);
      return {
        items: rows.map((row) => mapConversation(rowOf(row) as SqlRow)),
        total: totalRow === null ? 0 : readNumber(totalRow, 'total'),
      };
    },

    countLast24h(now?: Date): number {
      const since = new Date((now ?? db.now()).getTime() - DAY_MS).toISOString();
      const row = rowOf(
        db.statement('SELECT COUNT(*) AS total FROM messages WHERE created_at >= ?').get(since),
      );
      return row === null ? 0 : readNumber(row, 'total');
    },

    countByPlatformLast24h(now?: Date): PlatformCount[] {
      const since = new Date((now ?? db.now()).getTime() - DAY_MS).toISOString();
      return db
        .statement(
          `SELECT platform, COUNT(*) AS total FROM messages
           WHERE created_at >= ?
           GROUP BY platform
           ORDER BY total DESC, platform ASC`,
        )
        .all(since)
        .map((raw) => {
          const row = rowOf(raw) as SqlRow;
          return {
            platform: readString(row, 'platform') as Platform,
            count: readNumber(row, 'total'),
          };
        });
    },

    trendLast24h(now?: Date, bucketMinutes?: number): MessageTrendPoint[] {
      const nowDate = now ?? db.now();
      const minutes = normalizeBucketMinutes(bucketMinutes);
      const bucketMs = minutes * 60 * 1000;
      const bucketCount = Math.max(1, Math.ceil(MINUTES_PER_DAY / minutes));
      const lastBucketStartMs = Math.floor(nowDate.getTime() / bucketMs) * bucketMs;
      const firstBucketStartMs = lastBucketStartMs - (bucketCount - 1) * bucketMs;

      const buckets: MessageTrendPoint[] = [];
      for (let index = 0; index < bucketCount; index += 1) {
        buckets.push({
          bucket: new Date(firstBucketStartMs + index * bucketMs).toISOString(),
          total: 0,
          byPlatform: { discord: 0, 'qq-official': 0 },
        });
      }

      const rows = db
        .statement('SELECT platform, created_at FROM messages WHERE created_at >= ?')
        .all(new Date(firstBucketStartMs).toISOString());
      for (const raw of rows) {
        const row = rowOf(raw) as SqlRow;
        const createdMs = Date.parse(readString(row, 'created_at'));
        if (!Number.isFinite(createdMs)) {
          continue;
        }
        const index = Math.floor((createdMs - firstBucketStartMs) / bucketMs);
        const bucket = buckets[index];
        if (bucket === undefined) {
          continue;
        }
        bucket.total += 1;
        const platform = readString(row, 'platform');
        bucket.byPlatform[platform] = (bucket.byPlatform[platform] ?? 0) + 1;
      }
      return buckets;
    },

    prune(olderThanDays: number, now?: Date): number {
      if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
        return 0;
      }
      const cutoff = new Date(
        (now ?? db.now()).getTime() - Math.floor(olderThanDays) * DAY_MS,
      ).toISOString();
      return readChanges(db.statement('DELETE FROM messages WHERE created_at < ?').run(cutoff));
    },
  };
}
