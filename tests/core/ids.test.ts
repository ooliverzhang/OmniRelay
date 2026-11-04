import { describe, expect, it } from 'vitest';

import {
  createBridgeMessageId,
  createEventId,
  discordDedupeKey,
  qqDedupeKey,
} from '@omni-relay/core';

describe('createEventId', () => {
  it('produces a prefixed hex id', () => {
    expect(createEventId()).toMatch(/^evt_[0-9a-f]{32}$/);
  });

  it('honours a custom prefix', () => {
    expect(createEventId('adhoc')).toMatch(/^adhoc_[0-9a-f]{32}$/);
  });
});

describe('createBridgeMessageId', () => {
  it('is stable for the same native message id', () => {
    const first = createBridgeMessageId('discord', '123456789012345678');
    const second = createBridgeMessageId('discord', '123456789012345678');
    expect(first).toBe(second);
    expect(first).toMatch(/^brg_discord_[0-9a-f]{16}$/);
  });

  it('differs across native message ids', () => {
    expect(createBridgeMessageId('discord', 'a')).not.toBe(createBridgeMessageId('discord', 'b'));
  });

  it('falls back to a random suffix without a native id', () => {
    const first = createBridgeMessageId('qq-official');
    const second = createBridgeMessageId('qq-official');
    expect(first).toMatch(/^brg_qq-official_[0-9a-f]{16}$/);
    expect(second).toMatch(/^brg_qq-official_[0-9a-f]{16}$/);
    expect(first).not.toBe(second);
  });
});

describe('dedupe keys', () => {
  it('builds discord keys', () => {
    expect(discordDedupeKey('42')).toBe('discord:42');
  });

  it('builds qq keys with an explicit msgSeq', () => {
    expect(qqDedupeKey('42', '7')).toBe('qq:42:7');
    expect(qqDedupeKey('42', 7)).toBe('qq:42:7');
  });

  it('defaults the qq msgSeq to zero', () => {
    expect(qqDedupeKey('42')).toBe('qq:42:0');
    expect(qqDedupeKey('42', null)).toBe('qq:42:0');
  });
});
