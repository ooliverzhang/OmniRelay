import {
  DEFAULT_RESPONSE_POLICY,
  type ConversationKind,
  type MessageRule,
  type Platform,
  type RateLimitConfig,
  type ResponsePolicy,
  type ScheduleConfig,
  type TriggerConfig,
} from '@omni-relay/shared-types';

import type { RuleRepo } from '../contracts.js';
import {
  parseJson,
  parseJsonOrNull,
  readBoolean,
  readNumber,
  readString,
  rowOf,
  type SqlParam,
  type SqlRow,
  type StorageDb,
} from '../db.js';

const COLUMNS = `id, name, enabled, priority, platforms_json, conversation_kinds_json,
  group_ids_json, channel_ids_json, user_ids_json, trigger_json, response_json,
  rate_limit_json, schedule_json, created_at, updated_at`;

/** Priority spacing leaves room to insert rules manually between two entries. */
export const PRIORITY_STEP = 10;

function mapRule(row: SqlRow): MessageRule {
  const rule: MessageRule = {
    id: readString(row, 'id'),
    name: readString(row, 'name'),
    enabled: readBoolean(row, 'enabled'),
    priority: readNumber(row, 'priority'),
    platforms: parseJson<Platform[]>(row.platforms_json, []),
    conversationKinds: parseJson<ConversationKind[]>(row.conversation_kinds_json, []),
    groupIds: parseJson<string[]>(row.group_ids_json, []),
    channelIds: parseJson<string[]>(row.channel_ids_json, []),
    userIds: parseJson<string[]>(row.user_ids_json, []),
    trigger: parseJson<TriggerConfig>(row.trigger_json, {}),
    response: parseJson<ResponsePolicy>(row.response_json, { ...DEFAULT_RESPONSE_POLICY }),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
  const rateLimit = parseJsonOrNull<RateLimitConfig>(row.rate_limit_json);
  if (rateLimit !== null) {
    rule.rateLimit = rateLimit;
  }
  const schedule = parseJsonOrNull<ScheduleConfig>(row.schedule_json);
  if (schedule !== null) {
    rule.schedule = schedule;
  }
  return rule;
}

function toParams(rule: MessageRule): SqlParam[] {
  return [
    rule.id,
    rule.name,
    rule.enabled ? 1 : 0,
    rule.priority,
    JSON.stringify(rule.platforms),
    JSON.stringify(rule.conversationKinds),
    JSON.stringify(rule.groupIds),
    JSON.stringify(rule.channelIds),
    JSON.stringify(rule.userIds),
    JSON.stringify(rule.trigger),
    JSON.stringify(rule.response),
    rule.rateLimit === undefined ? null : JSON.stringify(rule.rateLimit),
    rule.schedule === undefined ? null : JSON.stringify(rule.schedule),
    rule.createdAt,
    rule.updatedAt,
  ];
}

export function createRuleRepo(db: StorageDb): RuleRepo {
  const list = (): MessageRule[] =>
    db
      .statement(`SELECT ${COLUMNS} FROM rules ORDER BY priority DESC, created_at ASC, id ASC`)
      .all()
      .map((row) => mapRule(rowOf(row) as SqlRow));

  const get = (id: string): MessageRule | null => {
    const row = rowOf(db.statement(`SELECT ${COLUMNS} FROM rules WHERE id = ?`).get(id));
    return row === null ? null : mapRule(row);
  };

  return {
    list,
    listEnabled(): MessageRule[] {
      return db
        .statement(
          `SELECT ${COLUMNS} FROM rules WHERE enabled = 1
           ORDER BY priority DESC, created_at ASC, id ASC`,
        )
        .all()
        .map((row) => mapRule(rowOf(row) as SqlRow));
    },
    get,
    create(rule: MessageRule): MessageRule {
      db.statement(
        `INSERT INTO rules
          (id, name, enabled, priority, platforms_json, conversation_kinds_json, group_ids_json,
           channel_ids_json, user_ids_json, trigger_json, response_json, rate_limit_json,
           schedule_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(...toParams(rule));
      return get(rule.id) ?? rule;
    },
    update(id, patch) {
      const existing = get(id);
      if (existing === null) {
        return null;
      }
      const merged: MessageRule = {
        ...existing,
        ...patch,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: patch.updatedAt ?? db.now().toISOString(),
      };
      db.statement(
        `UPDATE rules SET
           name = ?, enabled = ?, priority = ?, platforms_json = ?, conversation_kinds_json = ?,
           group_ids_json = ?, channel_ids_json = ?, user_ids_json = ?, trigger_json = ?,
           response_json = ?, rate_limit_json = ?, schedule_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        merged.name,
        merged.enabled ? 1 : 0,
        merged.priority,
        JSON.stringify(merged.platforms),
        JSON.stringify(merged.conversationKinds),
        JSON.stringify(merged.groupIds),
        JSON.stringify(merged.channelIds),
        JSON.stringify(merged.userIds),
        JSON.stringify(merged.trigger),
        JSON.stringify(merged.response),
        merged.rateLimit === undefined ? null : JSON.stringify(merged.rateLimit),
        merged.schedule === undefined ? null : JSON.stringify(merged.schedule),
        merged.updatedAt,
        id,
      );
      return get(id);
    },
    remove(id: string): boolean {
      const result = db.statement('DELETE FROM rules WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },
    reorder(orderedIds: string[]): MessageRule[] {
      db.transaction(() => {
        const existing = list();
        const total = existing.length;
        const timestamp = db.now().toISOString();
        const update = db.statement('UPDATE rules SET priority = ?, updated_at = ? WHERE id = ?');
        orderedIds.forEach((id, index) => {
          // The first entry gets the highest priority value.
          update.run((total - index) * PRIORITY_STEP, timestamp, id);
        });
      });
      return list();
    },
    counts(): { total: number; enabled: number } {
      const row = rowOf(
        db
          .statement(
            'SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled FROM rules',
          )
          .get(),
      );
      return {
        total: row === null ? 0 : readNumber(row, 'total'),
        enabled: row === null ? 0 : readNumber(row, 'enabled'),
      };
    },
    nextPriority(): number {
      const row = rowOf(db.statement('SELECT MAX(priority) AS highest FROM rules').get());
      if (row === null) {
        return PRIORITY_STEP;
      }
      const highest = row.highest;
      if (highest === null || highest === undefined) {
        return PRIORITY_STEP;
      }
      const value = typeof highest === 'bigint' ? Number(highest) : Number(highest);
      return Number.isFinite(value) ? value + PRIORITY_STEP : PRIORITY_STEP;
    },
  };
}
