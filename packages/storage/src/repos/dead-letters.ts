import type {
  ConversationKind,
  DeadLetterRecord,
  OutgoingMessage,
  Platform,
} from '@omni-relay/shared-types';

import type { DeadLetterRepo } from '../contracts.js';
import { normalizePage } from '../contracts.js';
import {
  parseJson,
  readNumber,
  readString,
  rowOf,
  type SqlParam,
  type SqlRow,
  type StorageDb,
} from '../db.js';

const COLUMNS = `id, outbox_id, platform, reason_code, reason_message, payload_json,
  conversation_kind, conversation_native_id, failed_at, attempts`;

export function mapDeadLetterRow(row: SqlRow): DeadLetterRecord {
  return {
    id: readString(row, 'id'),
    outboxId: readString(row, 'outbox_id'),
    platform: readString(row, 'platform') as Platform,
    reasonCode: readString(row, 'reason_code'),
    reasonMessage: readString(row, 'reason_message'),
    payload: parseJson<OutgoingMessage>(row.payload_json, {
      kind: readString(row, 'conversation_kind') as ConversationKind,
      segments: [],
      proactive: false,
    }),
    conversationKind: readString(row, 'conversation_kind') as ConversationKind,
    conversationNativeId: readString(row, 'conversation_native_id'),
    failedAt: readString(row, 'failed_at'),
    attempts: readNumber(row, 'attempts'),
  };
}

export function createDeadLetterRepo(db: StorageDb): DeadLetterRepo {
  return {
    list(query) {
      const conditions: string[] = [];
      const params: SqlParam[] = [];
      if (query.platform !== undefined) {
        conditions.push('platform = ?');
        params.push(query.platform);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const { page, pageSize } = normalizePage(query);
      const totalRow = rowOf(
        db.statement(`SELECT COUNT(*) AS total FROM dead_letters ${where}`).get(...params),
      );
      const rows = db
        .statement(
          `SELECT ${COLUMNS} FROM dead_letters ${where}
           ORDER BY failed_at DESC, id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (page - 1) * pageSize);
      return {
        items: rows.map((row) => mapDeadLetterRow(rowOf(row) as SqlRow)),
        total: totalRow === null ? 0 : readNumber(totalRow, 'total'),
      };
    },

    get(id: string): DeadLetterRecord | null {
      const row = rowOf(db.statement(`SELECT ${COLUMNS} FROM dead_letters WHERE id = ?`).get(id));
      return row === null ? null : mapDeadLetterRow(row);
    },

    delete(id: string): boolean {
      const result = db.statement('DELETE FROM dead_letters WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },

    count(): number {
      const row = rowOf(db.statement('SELECT COUNT(*) AS total FROM dead_letters').get());
      return row === null ? 0 : readNumber(row, 'total');
    },
  };
}
