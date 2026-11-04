import { randomUUID } from 'node:crypto';

import type { DeliveryAttemptRecord } from '@omni-relay/shared-types';

import type { DeliveryAttemptRepo } from '../contracts.js';
import {
  readNumber,
  readNullableString,
  readString,
  rowOf,
  type SqlRow,
  type StorageDb,
} from '../db.js';

const COLUMNS =
  'id, outbox_id, attempt, status, error_code, error_message, started_at, finished_at';

function mapAttempt(row: SqlRow): DeliveryAttemptRecord {
  const record: DeliveryAttemptRecord = {
    id: readString(row, 'id'),
    outboxId: readString(row, 'outbox_id'),
    attempt: readNumber(row, 'attempt'),
    status: readString(row, 'status') as DeliveryAttemptRecord['status'],
    startedAt: readString(row, 'started_at'),
    finishedAt: readString(row, 'finished_at'),
  };
  const errorCode = readNullableString(row, 'error_code');
  if (errorCode !== null) {
    record.errorCode = errorCode;
  }
  const errorMessage = readNullableString(row, 'error_message');
  if (errorMessage !== null) {
    record.errorMessage = errorMessage;
  }
  return record;
}

export function createDeliveryAttemptRepo(db: StorageDb): DeliveryAttemptRepo {
  return {
    record(input) {
      const attempt: DeliveryAttemptRecord = {
        id: `att_${randomUUID()}`,
        outboxId: input.outboxId,
        attempt: input.attempt,
        status: input.status,
        startedAt: input.startedAt.toISOString(),
        finishedAt: input.finishedAt.toISOString(),
      };
      if (input.errorCode !== undefined) {
        attempt.errorCode = input.errorCode;
      }
      if (input.errorMessage !== undefined) {
        attempt.errorMessage = input.errorMessage;
      }
      db.statement(
        `INSERT INTO delivery_attempts
          (id, outbox_id, attempt, status, error_code, error_message, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        attempt.id,
        attempt.outboxId,
        attempt.attempt,
        attempt.status,
        attempt.errorCode ?? null,
        attempt.errorMessage ?? null,
        attempt.startedAt,
        attempt.finishedAt,
      );
      return attempt;
    },

    listByOutbox(outboxId: string): DeliveryAttemptRecord[] {
      return db
        .statement(
          `SELECT ${COLUMNS} FROM delivery_attempts WHERE outbox_id = ?
           ORDER BY attempt ASC, started_at ASC`,
        )
        .all(outboxId)
        .map((row) => mapAttempt(rowOf(row) as SqlRow));
    },

    count(): number {
      const row = rowOf(db.statement('SELECT COUNT(*) AS total FROM delivery_attempts').get());
      return row === null ? 0 : readNumber(row, 'total');
    },
  };
}
