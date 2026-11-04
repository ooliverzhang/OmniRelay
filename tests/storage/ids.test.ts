import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Storage } from '@omni-relay/storage';

import { createStorage } from './helpers';

let storage: Storage;

beforeEach(() => {
  storage = createStorage();
});

afterEach(() => {
  storage.close();
});

describe('id mappings', () => {
  it('returns a stable OneBot id for the same native identity', () => {
    const first = storage.ids.getOrCreate({
      platform: 'discord',
      nativeKind: 'user',
      nativeId: 'user-1',
      displayName: 'Alice',
    });
    const second = storage.ids.getOrCreate({
      platform: 'discord',
      nativeKind: 'user',
      nativeId: 'user-1',
    });

    expect(second.onebotId).toBe(first.onebotId);
    expect(second.onebotKind).toBe('user');
    expect(first.onebotKind).toBe('user');
    expect(first.onebotId).toBe(1_000_000_001);
    expect(first.displayName).toBe('Alice');
    expect(storage.ids.count()).toBe(1);
  });

  it('keeps the user and group id ranges disjoint', () => {
    const user = storage.ids.getOrCreate({
      platform: 'discord',
      nativeKind: 'user',
      nativeId: 'user-1',
    });
    const channel = storage.ids.getOrCreate({
      platform: 'discord',
      nativeKind: 'channel',
      nativeId: 'channel-1',
    });
    const group = storage.ids.getOrCreate({
      platform: 'qq-official',
      nativeKind: 'group',
      nativeId: 'group-1',
    });

    expect(channel.onebotKind).toBe('group');
    expect(group.onebotKind).toBe('group');
    expect(user.onebotId).toBe(1_000_000_001);
    expect(channel.onebotId).toBe(2_000_000_001);
    expect(group.onebotId).toBe(2_000_000_002);
    expect(new Set([user.onebotId, channel.onebotId, group.onebotId]).size).toBe(3);
  });

  it('scopes identities by platform', () => {
    const discord = storage.ids.getOrCreate({
      platform: 'discord',
      nativeKind: 'user',
      nativeId: 'user-1',
    });
    const qq = storage.ids.getOrCreate({
      platform: 'qq-official',
      nativeKind: 'user',
      nativeId: 'user-1',
    });

    expect(qq.onebotId).not.toBe(discord.onebotId);
    expect(storage.ids.count()).toBe(2);
    expect(storage.ids.get('discord', 'user', 'user-1')?.onebotId).toBe(discord.onebotId);
  });

  it('never reuses an allocated id', () => {
    const allocated = new Set<number>();
    for (let index = 0; index < 5; index += 1) {
      const mapping = storage.ids.getOrCreate({
        platform: 'discord',
        nativeKind: 'user',
        nativeId: `user-${index}`,
      });
      allocated.add(mapping.onebotId);
    }
    expect(allocated.size).toBe(5);
  });

  it('supports reverse lookups and display name updates', () => {
    const mapping = storage.ids.getOrCreate({
      platform: 'discord',
      nativeKind: 'user',
      nativeId: 'user-1',
      displayName: 'Alice',
    });

    expect(storage.ids.getByOneBotId('user', mapping.onebotId)?.nativeId).toBe('user-1');
    expect(storage.ids.getByOneBotId('group', mapping.onebotId)).toBeNull();

    storage.ids.updateDisplayName('discord', 'user', 'user-1', 'Alice (renamed)');
    expect(storage.ids.get('discord', 'user', 'user-1')?.displayName).toBe('Alice (renamed)');
  });

  it('refreshes the display name on getOrCreate', () => {
    storage.ids.getOrCreate({
      platform: 'discord',
      nativeKind: 'user',
      nativeId: 'user-1',
      displayName: 'Old Name',
    });
    const updated = storage.ids.getOrCreate({
      platform: 'discord',
      nativeKind: 'user',
      nativeId: 'user-1',
      displayName: 'New Name',
    });
    expect(updated.displayName).toBe('New Name');
  });

  it('lists, filters, searches and paginates', () => {
    storage.ids.getOrCreate({
      platform: 'discord',
      nativeKind: 'user',
      nativeId: 'alice',
      displayName: 'Alice',
    });
    storage.ids.getOrCreate({
      platform: 'discord',
      nativeKind: 'channel',
      nativeId: 'general',
      displayName: 'General',
    });
    storage.ids.getOrCreate({
      platform: 'qq-official',
      nativeKind: 'group',
      nativeId: 'group-42',
      displayName: 'QQ Group',
    });

    expect(storage.ids.list({}).total).toBe(3);
    expect(storage.ids.list({ platform: 'discord' }).total).toBe(2);
    expect(storage.ids.list({ nativeKind: 'group' }).total).toBe(1);
    expect(storage.ids.list({ search: 'ali' }).items).toHaveLength(1);
    expect(storage.ids.list({ search: 'general' }).items[0]?.nativeId).toBe('general');

    const page = storage.ids.list({ pageSize: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    const secondPage = storage.ids.list({ pageSize: 2, page: 2 });
    expect(secondPage.items).toHaveLength(1);
  });
});
