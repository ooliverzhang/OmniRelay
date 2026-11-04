import {
  ONEBOT_ID_RANGES,
  nativeKindToOneBotKind,
  type IdMapping,
  type NativeIdKind,
  type OneBotIdKind,
  type Platform,
} from '@omni-relay/shared-types';

import type { GetOrCreateMappingInput, IdMappingRepo } from '../contracts.js';
import { normalizePage } from '../contracts.js';
import {
  likeClause,
  likePattern,
  readChanges,
  readNumber,
  readNullableString,
  readString,
  rowOf,
  type SqlParam,
  type SqlRow,
  type StorageDb,
} from '../db.js';

const COLUMNS =
  'platform, native_kind, native_id, onebot_kind, onebot_id, display_name, created_at, updated_at';

function mapMapping(row: SqlRow): IdMapping {
  const mapping: IdMapping = {
    platform: readString(row, 'platform') as Platform,
    nativeKind: readString(row, 'native_kind') as NativeIdKind,
    nativeId: readString(row, 'native_id'),
    onebotKind: readString(row, 'onebot_kind') as OneBotIdKind,
    onebotId: readNumber(row, 'onebot_id'),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
  const displayName = readNullableString(row, 'display_name');
  if (displayName !== null) {
    mapping.displayName = displayName;
  }
  return mapping;
}

export function createIdMappingRepo(db: StorageDb): IdMappingRepo {
  const selectByNative = (
    platform: Platform,
    nativeKind: NativeIdKind,
    nativeId: string,
  ): SqlRow | null =>
    rowOf(
      db
        .statement(
          `SELECT ${COLUMNS} FROM id_mappings
           WHERE platform = ? AND native_kind = ? AND native_id = ?`,
        )
        .get(platform, nativeKind, nativeId),
    );

  const allocateOneBotId = (onebotKind: OneBotIdKind): number => {
    const row = rowOf(
      db.statement('SELECT next_id FROM id_allocator WHERE onebot_kind = ?').get(onebotKind),
    );
    if (row === null) {
      throw new Error(`Missing OneBot id allocator for kind "${onebotKind}"`);
    }
    const nextId = readNumber(row, 'next_id');
    const range = ONEBOT_ID_RANGES[onebotKind];
    if (!Number.isInteger(nextId) || nextId < range.min || nextId > range.max) {
      throw new Error(`OneBot "${onebotKind}" id space exhausted at ${String(nextId)}`);
    }
    const result = db
      .statement('UPDATE id_allocator SET next_id = ? WHERE onebot_kind = ?')
      .run(nextId + 1, onebotKind);
    if (readChanges(result) !== 1) {
      throw new Error(`Failed to advance the OneBot "${onebotKind}" id allocator`);
    }
    return nextId;
  };

  const updateDisplayName = (
    platform: Platform,
    nativeKind: NativeIdKind,
    nativeId: string,
    displayName: string,
  ): void => {
    db.statement(
      `UPDATE id_mappings SET display_name = ?, updated_at = ?
       WHERE platform = ? AND native_kind = ? AND native_id = ?`,
    ).run(displayName, db.now().toISOString(), platform, nativeKind, nativeId);
  };

  const get = (
    platform: Platform,
    nativeKind: NativeIdKind,
    nativeId: string,
  ): IdMapping | null => {
    const row = selectByNative(platform, nativeKind, nativeId);
    return row === null ? null : mapMapping(row);
  };

  const getOrCreate = (input: GetOrCreateMappingInput): IdMapping => {
    const { platform, nativeKind, nativeId } = input;
    const displayName = input.displayName ?? null;
    return db.transaction(() => {
      const existing = selectByNative(platform, nativeKind, nativeId);
      if (existing !== null) {
        const mapping = mapMapping(existing);
        if (displayName !== null && mapping.displayName !== displayName) {
          updateDisplayName(platform, nativeKind, nativeId, displayName);
          return { ...mapping, displayName, updatedAt: db.now().toISOString() };
        }
        return mapping;
      }

      const onebotKind = nativeKindToOneBotKind(nativeKind);
      const onebotId = allocateOneBotId(onebotKind);
      const timestamp = db.now().toISOString();
      db.statement(
        `INSERT INTO id_mappings
          (platform, native_kind, native_id, onebot_kind, onebot_id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        platform,
        nativeKind,
        nativeId,
        onebotKind,
        onebotId,
        displayName,
        timestamp,
        timestamp,
      );

      const created: IdMapping = {
        platform,
        nativeKind,
        nativeId,
        onebotKind,
        onebotId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (displayName !== null) {
        created.displayName = displayName;
      }
      return created;
    });
  };

  return {
    getOrCreate,
    get,
    getByOneBotId(kind: OneBotIdKind, onebotId: number): IdMapping | null {
      const row = rowOf(
        db
          .statement(`SELECT ${COLUMNS} FROM id_mappings WHERE onebot_kind = ? AND onebot_id = ?`)
          .get(kind, onebotId),
      );
      return row === null ? null : mapMapping(row);
    },
    updateDisplayName,
    list(query) {
      const conditions: string[] = [];
      const params: SqlParam[] = [];
      if (query.platform !== undefined) {
        conditions.push('platform = ?');
        params.push(query.platform);
      }
      if (query.nativeKind !== undefined) {
        conditions.push('native_kind = ?');
        params.push(query.nativeKind);
      }
      const search = query.search?.trim().slice(0, 200);
      if (search !== undefined && search.length > 0) {
        conditions.push(`(${likeClause('native_id')} OR ${likeClause('display_name')})`);
        const pattern = likePattern(search);
        params.push(pattern, pattern);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const { page, pageSize } = normalizePage(query);
      const totalRow = rowOf(
        db.statement(`SELECT COUNT(*) AS total FROM id_mappings ${where}`).get(...params),
      );
      const rows = db
        .statement(
          `SELECT ${COLUMNS} FROM id_mappings ${where}
           ORDER BY platform ASC, native_kind ASC, native_id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (page - 1) * pageSize);
      return {
        items: rows.map((row) => mapMapping(rowOf(row) as SqlRow)),
        total: totalRow === null ? 0 : readNumber(totalRow, 'total'),
      };
    },
    count(): number {
      const row = rowOf(db.statement('SELECT COUNT(*) AS total FROM id_mappings').get());
      return row === null ? 0 : readNumber(row, 'total');
    },
  };
}
