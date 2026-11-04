import { randomUUID } from 'node:crypto';

import type {
  ConversationKind,
  DeadLetterRecord,
  DeliveryStatus,
  FailureInfo,
  OutgoingMessage,
  OutboxRecord,
  Platform,
} from '@omni-relay/shared-types';

import type { EnqueueOutboxInput, OutboxRepo, OutboxStats } from '../contracts.js';
import { normalizePage } from '../contracts.js';
import {
  parseJson,
  parseJsonOrNull,
  readChanges,
  readNumber,
  readNullableString,
  readString,
  rowOf,
  type SqlParam,
  type SqlRow,
  type StorageDb,
} from '../db.js';

export const DEFAULT_MAX_ATTEMPTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const COLUMNS = `id, platform, conversation_kind, conversation_native_id, sender_native_id,
  payload_json, status, attempts, max_attempts, next_attempt_at, last_error_json, rule_id,
  bridge_message_id, created_at, updated_at`;

function fallbackPayload(row: SqlRow): OutgoingMessage {
  return {
    kind: readString(row, 'conversation_kind') as ConversationKind,
    segments: [],
    proactive: false,
  };
}

export function mapOutboxRow(row: SqlRow): OutboxRecord {
  const record: OutboxRecord = {
    id: readString(row, 'id'),
    platform: readString(row, 'platform') as Platform,
    conversationKind: readString(row, 'conversation_kind') as ConversationKind,
    conversationNativeId: readString(row, 'conversation_native_id'),
    senderNativeId: readString(row, 'sender_native_id'),
    payload: parseJson<OutgoingMessage>(row.payload_json, fallbackPayload(row)),
    status: readString(row, 'status') as DeliveryStatus,
    attempts: readNumber(row, 'attempts'),
    maxAttempts: readNumber(row, 'max_attempts', DEFAULT_MAX_ATTEMPTS),
    nextAttemptAt: readString(row, 'next_attempt_at'),
    bridgeMessageId: readString(row, 'bridge_message_id'),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
  const lastError = parseJsonOrNull<FailureInfo>(row.last_error_json);
  if (lastError !== null) {
    record.lastError = lastError;
  }
  const ruleId = readNullableString(row, 'rule_id');
  if (ruleId !== null) {
    record.ruleId = ruleId;
  }
  return record;
}

function normalizeMaxAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  return Math.floor(value);
}

function countWhere(db: StorageDb, sql: string, ...params: SqlParam[]): number {
  const row = rowOf(db.statement(sql).get(...params));
  return row === null ? 0 : readNumber(row, 'total');
}

export function createOutboxRepo(db: StorageDb): OutboxRepo {
  return {
    enqueue(input: EnqueueOutboxInput): OutboxRecord {
      const nowDate = db.now();
      const timestamp = nowDate.toISOString();
      const nextAttemptAt = (input.nextAttemptAt ?? nowDate).toISOString();
      const maxAttempts = normalizeMaxAttempts(input.maxAttempts);
      const id = `out_${randomUUID()}`;
      const ruleId = input.ruleId ?? null;

      db.statement(
        `INSERT INTO outbox_messages
          (id, platform, conversation_kind, conversation_native_id, sender_native_id, payload_json,
           status, attempts, max_attempts, next_attempt_at, last_error_json, rule_id,
           bridge_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, ?, ?, ?, ?)`,
      ).run(
        id,
        input.platform,
        input.conversationKind,
        input.conversationNativeId,
        input.senderNativeId,
        JSON.stringify(input.payload),
        maxAttempts,
        nextAttemptAt,
        ruleId,
        input.bridgeMessageId,
        timestamp,
        timestamp,
      );

      const record: OutboxRecord = {
        id,
        platform: input.platform,
        conversationKind: input.conversationKind,
        conversationNativeId: input.conversationNativeId,
        senderNativeId: input.senderNativeId,
        payload: input.payload,
        status: 'queued',
        attempts: 0,
        maxAttempts,
        nextAttemptAt,
        bridgeMessageId: input.bridgeMessageId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (input.ruleId !== undefined) {
        record.ruleId = input.ruleId;
      }
      return record;
    },

    get(id: string): OutboxRecord | null {
      const row = rowOf(
        db.statement(`SELECT ${COLUMNS} FROM outbox_messages WHERE id = ?`).get(id),
      );
      return row === null ? null : mapOutboxRow(row);
    },

    claimDue(options) {
      const nowIso = (options?.now ?? db.now()).toISOString();
      const requested = options?.limit ?? 10;
      const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 10;

      return db.transaction(() => {
        const rows = db
          .statement(
            `SELECT ${COLUMNS} FROM outbox_messages
             WHERE status IN ('queued', 'retrying') AND next_attempt_at <= ?
             ORDER BY next_attempt_at ASC, created_at ASC
             LIMIT ?`,
          )
          .all(nowIso, limit);
        if (rows.length === 0) {
          return [];
        }
        // Snapshot the records *before* flipping them to "sending".
        const claimed = rows.map((row) => mapOutboxRow(rowOf(row) as SqlRow));
        const update = db.statement(
          `UPDATE outbox_messages SET status = 'sending', updated_at = ? WHERE id = ?`,
        );
        for (const record of claimed) {
          update.run(nowIso, record.id);
        }
        return claimed;
      });
    },

    markSent(id, info) {
      const nowIso = (info?.now ?? db.now()).toISOString();
      const result = db
        .statement(`UPDATE outbox_messages SET status = 'sent', updated_at = ? WHERE id = ?`)
        .run(nowIso, id);
      if (readChanges(result) === 0) {
        throw new Error(`Outbox record "${id}" does not exist`);
      }
    },

    markRetry(id, input) {
      const nowIso = (input.now ?? db.now()).toISOString();
      db.transaction(() => {
        const current = rowOf(
          db.statement('SELECT attempts FROM outbox_messages WHERE id = ?').get(id),
        );
        if (current === null) {
          throw new Error(`Outbox record "${id}" does not exist`);
        }
        db.statement(
          `UPDATE outbox_messages
           SET status = 'retrying', attempts = ?, last_error_json = ?, next_attempt_at = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          readNumber(current, 'attempts') + 1,
          JSON.stringify(input.failure),
          input.nextAttemptAt.toISOString(),
          nowIso,
          id,
        );
      });
    },

    markDead(id, input): DeadLetterRecord {
      const failedAt = (input.now ?? db.now()).toISOString();
      return db.transaction(() => {
        const row = rowOf(
          db.statement(`SELECT ${COLUMNS} FROM outbox_messages WHERE id = ?`).get(id),
        );
        if (row === null) {
          throw new Error(`Outbox record "${id}" does not exist`);
        }
        const record = mapOutboxRow(row);
        const deadLetter: DeadLetterRecord = {
          id: `dl_${randomUUID()}`,
          outboxId: record.id,
          platform: record.platform,
          reasonCode: input.failure.code,
          reasonMessage: input.failure.message,
          payload: record.payload,
          conversationKind: record.conversationKind,
          conversationNativeId: record.conversationNativeId,
          failedAt,
          // The failed attempt itself counts even though the outbox row never
          // got its `attempts` column bumped.
          attempts: record.attempts + 1,
        };
        db.statement(
          `INSERT INTO dead_letters
            (id, outbox_id, platform, reason_code, reason_message, payload_json,
             conversation_kind, conversation_native_id, failed_at, attempts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          deadLetter.id,
          deadLetter.outboxId,
          deadLetter.platform,
          deadLetter.reasonCode,
          deadLetter.reasonMessage,
          JSON.stringify(deadLetter.payload),
          deadLetter.conversationKind,
          deadLetter.conversationNativeId,
          deadLetter.failedAt,
          deadLetter.attempts,
        );
        db.statement('DELETE FROM outbox_messages WHERE id = ?').run(id);
        return deadLetter;
      });
    },

    requeue(id, now) {
      const nowIso = (now ?? db.now()).toISOString();
      const result = db
        .statement(
          `UPDATE outbox_messages
           SET status = 'queued', attempts = 0, last_error_json = NULL,
               next_attempt_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso, nowIso, id);
      return readChanges(result) > 0;
    },

    delete(id: string): boolean {
      return readChanges(db.statement('DELETE FROM outbox_messages WHERE id = ?').run(id)) > 0;
    },

    list(query) {
      const conditions: string[] = [];
      const params: SqlParam[] = [];
      if (query.status !== undefined) {
        conditions.push('status = ?');
        params.push(query.status);
      }
      if (query.platform !== undefined) {
        conditions.push('platform = ?');
        params.push(query.platform);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const { page, pageSize } = normalizePage(query);
      const total = countWhere(
        db,
        `SELECT COUNT(*) AS total FROM outbox_messages ${where}`,
        ...params,
      );
      const rows = db
        .statement(
          `SELECT ${COLUMNS} FROM outbox_messages ${where}
           ORDER BY created_at DESC, id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (page - 1) * pageSize);
      return { items: rows.map((row) => mapOutboxRow(rowOf(row) as SqlRow)), total };
    },

    stats(now?: Date): OutboxStats {
      const nowDate = now ?? db.now();
      const since24h = new Date(nowDate.getTime() - DAY_MS).toISOString();
      return db.transaction(() => ({
        queued: countWhere(
          db,
          `SELECT COUNT(*) AS total FROM outbox_messages WHERE status = 'queued'`,
        ),
        sending: countWhere(
          db,
          `SELECT COUNT(*) AS total FROM outbox_messages WHERE status = 'sending'`,
        ),
        retrying: countWhere(
          db,
          `SELECT COUNT(*) AS total FROM outbox_messages WHERE status = 'retrying'`,
        ),
        dead: countWhere(db, 'SELECT COUNT(*) AS total FROM dead_letters'),
        sent24h: countWhere(
          db,
          `SELECT COUNT(*) AS total FROM outbox_messages WHERE status = 'sent' AND updated_at >= ?`,
          since24h,
        ),
        failed24h: countWhere(
          db,
          'SELECT COUNT(*) AS total FROM dead_letters WHERE failed_at >= ?',
          since24h,
        ),
      }));
    },

    dueCount(now?: Date): number {
      const nowIso = (now ?? db.now()).toISOString();
      return countWhere(
        db,
        `SELECT COUNT(*) AS total FROM outbox_messages
         WHERE status IN ('queued', 'retrying') AND next_attempt_at <= ?`,
        nowIso,
      );
    },

    countByStatus(): Partial<Record<DeliveryStatus, number>> {
      const rows = db
        .statement('SELECT status, COUNT(*) AS total FROM outbox_messages GROUP BY status')
        .all();
      const counts: Partial<Record<DeliveryStatus, number>> = {};
      for (const raw of rows) {
        const row = rowOf(raw);
        if (row === null) {
          continue;
        }
        counts[readString(row, 'status') as DeliveryStatus] = readNumber(row, 'total');
      }
      return counts;
    },
  };
}
