import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MessageRecordInput, Storage } from '@omni-relay/storage';

import { createClock, createStorage, type TestClock } from './helpers';

const START = '2026-01-01T12:30:00.000Z';

let storage: Storage;
let clock: TestClock;

beforeEach(() => {
  clock = createClock(START);
  storage = createStorage(clock.now);
});

afterEach(() => {
  storage.close();
});

function record(overrides: Partial<MessageRecordInput> = {}) {
  const input: MessageRecordInput = {
    bridgeMessageId: 'bridge-1',
    platform: 'discord',
    conversationKind: 'group',
    conversationNativeId: 'channel-1',
    conversationDisplayName: 'General',
    senderNativeId: 'user-1',
    senderDisplayName: 'Alice',
    onebotUserId: 1_000_000_001,
    onebotGroupId: 2_000_000_001,
    segments: [{ type: 'text', text: 'hello world' }],
    text: 'hello world',
    status: 'sent',
    createdAt: new Date('2026-01-01T12:00:00.000Z'),
    ...overrides,
  };
  return storage.messages.record(input);
}

describe('messages read model', () => {
  it('records messages with segment metadata', () => {
    const row = record({
      segments: [
        { type: 'text', text: 'hi' },
        { type: 'image', url: 'https://example.test/a.png' },
      ],
      text: 'hi',
      matchedRuleId: 'rule-1',
      reason: 'matched',
      nativeMessageId: 'native-1',
    });

    expect(row.id).toMatch(/^msg_/);
    expect(row.bridgeMessageId).toBe('bridge-1');
    expect(row.platform).toBe('discord');
    expect(row.conversationKind).toBe('group');
    expect(row.conversationDisplayName).toBe('General');
    expect(row.senderDisplayName).toBe('Alice');
    expect(row.onebotUserId).toBe(1_000_000_001);
    expect(row.onebotGroupId).toBe(2_000_000_001);
    expect(row.segmentTypes).toEqual(['text', 'image']);
    expect(row.segments).toHaveLength(2);
    expect(row.text).toBe('hi');
    expect(row.status).toBe('sent');
    expect(row.reason).toBe('matched');
    expect(row.matchedRuleId).toBe('rule-1');
    expect(row.nativeMessageId).toBe('native-1');
    expect(row.createdAt).toBe('2026-01-01T12:00:00.000Z');
  });

  it('lists, filters, searches and paginates', () => {
    record({
      bridgeMessageId: 'bridge-1',
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
      text: 'hello from discord',
    });
    record({
      bridgeMessageId: 'bridge-2',
      conversationNativeId: 'channel-2',
      conversationDisplayName: 'Random',
      createdAt: new Date('2026-01-01T11:00:00.000Z'),
      text: 'groceries',
    });
    record({
      bridgeMessageId: 'bridge-3',
      platform: 'qq-official',
      conversationKind: 'private',
      conversationNativeId: 'openid-1',
      conversationDisplayName: 'QQ DM',
      senderNativeId: 'qq-user-1',
      onebotUserId: null,
      onebotGroupId: null,
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
      text: 'hello from qq',
    });

    const all = storage.messages.list({});
    expect(all.total).toBe(3);
    expect(all.items.map((row) => row.bridgeMessageId)).toEqual([
      'bridge-1',
      'bridge-2',
      'bridge-3',
    ]);

    expect(storage.messages.list({ platform: 'qq-official' }).total).toBe(1);
    expect(storage.messages.list({ conversationKind: 'private' }).total).toBe(1);
    expect(storage.messages.list({ conversationNativeId: 'channel-2' }).total).toBe(1);
    expect(storage.messages.list({ senderNativeId: 'user-1' }).total).toBe(2);
    expect(storage.messages.list({ search: 'groceries' }).total).toBe(1);
    expect(storage.messages.list({ search: 'hello' }).total).toBe(2);

    const page = storage.messages.list({ pageSize: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(storage.messages.list({ pageSize: 2, page: 2 }).items).toHaveLength(1);
  });

  it('builds 24 hourly trend buckets with empty buckets included', () => {
    record({ createdAt: new Date('2026-01-01T12:10:00.000Z') });
    record({ createdAt: new Date('2026-01-01T11:30:00.000Z') });
    record({ createdAt: new Date('2025-12-31T13:30:00.000Z') });
    record({
      platform: 'qq-official',
      createdAt: new Date('2025-12-31T22:30:00.000Z'),
    });
    // Older than the 24 bucket window: must not be counted.
    record({ createdAt: new Date('2025-12-31T12:30:00.000Z') });

    const trend = storage.messages.trendLast24h();
    expect(trend).toHaveLength(24);
    expect(trend[0]?.bucket).toBe('2025-12-31T13:00:00.000Z');
    expect(trend[23]?.bucket).toBe('2026-01-01T12:00:00.000Z');
    expect(trend[0]?.total).toBe(1);
    expect(trend[9]?.total).toBe(1);
    expect(trend[9]?.byPlatform['qq-official']).toBe(1);
    expect(trend[22]?.total).toBe(1);
    expect(trend[23]?.total).toBe(1);
    expect(trend.reduce((sum, point) => sum + point.total, 0)).toBe(4);

    for (const point of trend) {
      expect(point.byPlatform).toHaveProperty('discord');
      expect(point.byPlatform).toHaveProperty('qq-official');
    }
    const buckets = trend.map((point) => point.bucket);
    expect([...buckets].sort()).toEqual(buckets);
  });

  it('supports custom bucket sizes', () => {
    record({ createdAt: new Date('2026-01-01T12:10:00.000Z') });
    const trend = storage.messages.trendLast24h(undefined, 30);
    expect(trend).toHaveLength(48);
    expect(trend[47]?.bucket).toBe('2026-01-01T12:30:00.000Z');
    expect(trend.reduce((sum, point) => sum + point.total, 0)).toBe(1);
  });

  it('aggregates conversations with latest display name and group id', () => {
    record({
      conversationNativeId: 'channel-1',
      conversationDisplayName: 'Old Name',
      onebotGroupId: 2_000_000_001,
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
    });
    record({
      conversationNativeId: 'channel-1',
      conversationDisplayName: null,
      onebotGroupId: null,
      createdAt: new Date('2026-01-01T11:00:00.000Z'),
    });
    record({
      conversationNativeId: 'channel-1',
      conversationDisplayName: null,
      onebotGroupId: null,
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
    });
    record({
      conversationKind: 'channel',
      conversationNativeId: 'chan-2',
      conversationDisplayName: 'Channel Two',
      createdAt: new Date('2026-01-01T12:20:00.000Z'),
    });
    record({
      platform: 'qq-official',
      conversationNativeId: 'group-9',
      conversationDisplayName: 'QQ Group',
      onebotGroupId: null,
      createdAt: new Date('2026-01-01T11:30:00.000Z'),
    });

    const conversations = storage.messages.conversations({});
    expect(conversations.total).toBe(3);
    expect(conversations.items.map((row) => row.conversationNativeId)).toEqual([
      'chan-2',
      'channel-1',
      'group-9',
    ]);

    const channelOne = conversations.items[1];
    expect(channelOne?.messageCount).toBe(3);
    expect(channelOne?.displayName).toBe('Old Name');
    expect(channelOne?.onebotGroupId).toBe(2_000_000_001);
    expect(channelOne?.lastMessageAt).toBe('2026-01-01T12:00:00.000Z');

    expect(storage.messages.conversations({ platform: 'discord' }).total).toBe(2);
    expect(storage.messages.conversations({ search: 'chan-2' }).total).toBe(1);
    expect(storage.messages.conversations({ search: 'QQ' }).total).toBe(1);

    const page = storage.messages.conversations({ pageSize: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
    expect(storage.messages.conversations({ pageSize: 1, page: 2 }).items).toHaveLength(1);
  });

  it('counts messages in the last 24 hours', () => {
    record({ createdAt: new Date('2026-01-01T12:00:00.000Z') });
    record({ createdAt: new Date('2026-01-01T09:00:00.000Z') });
    record({ platform: 'qq-official', createdAt: new Date('2025-12-31T18:00:00.000Z') });
    record({ createdAt: new Date('2025-12-31T11:00:00.000Z') });

    expect(storage.messages.countLast24h()).toBe(3);
    const byPlatform = storage.messages.countByPlatformLast24h();
    expect(byPlatform).toEqual([
      { platform: 'discord', count: 2 },
      { platform: 'qq-official', count: 1 },
    ]);
  });

  it('prunes old messages', () => {
    record({ createdAt: new Date('2025-12-20T12:00:00.000Z') });
    record({ createdAt: new Date('2026-01-01T12:00:00.000Z') });

    expect(storage.messages.prune(7)).toBe(1);
    expect(storage.messages.list({}).total).toBe(1);
    expect(storage.messages.prune(7)).toBe(0);
  });
});
