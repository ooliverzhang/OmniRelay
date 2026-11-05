import { describe, expect, it } from 'vitest';

import {
  decodeCqText,
  normalizeDiscordMessage,
  normalizeQqMessage,
  onebotSegmentsToUnified,
  parseCqString,
  unifiedSegmentsToOneBotSegments,
  unifiedToOneBotEvent,
} from '@omni-relay/core';
import type { OneBotSegment, UnifiedMessageEvent } from '@omni-relay/shared-types';

const NOW = (): Date => new Date('2026-01-02T03:04:05.000Z');

const PRIVATE_EVENT: UnifiedMessageEvent = {
  eventId: 'evt_1',
  platform: 'discord',
  conversation: { kind: 'private', nativeId: 'user-1' },
  sender: { nativeId: 'user-1' },
  message: [{ type: 'text', text: 'hi' }],
  timestamp: '2026-01-02T03:04:05.000Z',
  mentionsBot: false,
  meta: {
    origin: 'discord',
    bridgeMessageId: 'brg_1',
    nativeMessageId: 'msg-1',
    createdAt: '2026-01-02T03:04:05.000Z',
  },
};

describe('unifiedToOneBotEvent', () => {
  it('maps a private event onto a friend message', () => {
    const event = unifiedToOneBotEvent(PRIVATE_EVENT, { selfId: 10001, userId: 90001 });
    expect(event).toMatchObject({
      time: 1767323045,
      self_id: 10001,
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 'msg-1',
      user_id: 90001,
    });
    expect(event.group_id).toBeUndefined();
  });

  it('maps a group event onto a group message', () => {
    const event = unifiedToOneBotEvent(
      { ...PRIVATE_EVENT, conversation: { kind: 'group', nativeId: 'chan-1' } },
      { selfId: 10001, userId: 90001, groupId: 20001 },
    );
    expect(event.message_type).toBe('group');
    expect(event.sub_type).toBe('normal');
    expect(event.group_id).toBe(20001);
  });

  it('treats channel conversations as groups', () => {
    const event = unifiedToOneBotEvent(
      { ...PRIVATE_EVENT, conversation: { kind: 'channel', nativeId: 'chan-2' } },
      { selfId: 10001, userId: 90002, groupId: 20002 },
    );
    expect(event.message_type).toBe('group');
    expect(event.group_id).toBe(20002);
  });

  it('converts every segment type', () => {
    const event = unifiedToOneBotEvent(
      {
        ...PRIVATE_EVENT,
        message: [
          { type: 'text', text: 'look' },
          { type: 'mention', userId: 'native-42' },
          { type: 'mention', userId: 'unknown' },
          { type: 'image', url: 'https://cdn.example/x.png' },
          { type: 'file', url: 'https://cdn.example/doc.pdf', filename: 'doc.pdf', size: 1024 },
          { type: 'reply', messageId: 'm-9' },
        ],
      },
      {
        selfId: 10001,
        userId: 90001,
        resolveMentionUserId: (nativeUserId) => (nativeUserId === 'native-42' ? 42 : null),
      },
    );

    expect(event.message).toEqual([
      { type: 'text', data: { text: 'look' } },
      { type: 'at', data: { qq: 42 } },
      {
        type: 'image',
        data: { file: 'https://cdn.example/x.png', url: 'https://cdn.example/x.png' },
      },
      {
        type: 'file',
        data: {
          file: 'doc.pdf',
          url: 'https://cdn.example/doc.pdf',
          name: 'doc.pdf',
          file_size: 1024,
        },
      },
      { type: 'reply', data: { id: 'm-9' } },
    ]);
  });

  it('handles events produced by the normalizers', () => {
    const inbound = normalizeQqMessage(
      {
        id: 'qq-msg-1',
        kind: 'c2c',
        userOpenId: 'open-user-1',
        content: 'hello',
        timestamp: 1_700_000_000,
      },
      { now: NOW },
    );
    const event = unifiedToOneBotEvent(inbound, { selfId: 10001, userId: 90003 });
    expect(event.message).toEqual([{ type: 'text', data: { text: 'hello' } }]);
    expect(event.time).toBe(1_700_000_000);
    expect(event.message_id).toBe('qq-msg-1');
  });

  it('falls back to the event id when the native message id is unknown', () => {
    const event = unifiedToOneBotEvent(
      { ...PRIVATE_EVENT, meta: { ...PRIVATE_EVENT.meta, nativeMessageId: undefined } },
      { selfId: 10001, userId: 90001 },
    );
    expect(event.message_id).toBe('evt_1');
  });
});

describe('onebotSegmentsToUnified', () => {
  const resolver = {
    toNativeUserId: (onebotId: number): string | null => (onebotId === 123 ? 'native-123' : null),
  };

  it('converts a resolvable at segment', () => {
    const result = onebotSegmentsToUnified(
      [{ type: 'at', data: { qq: 123, name: 'alice' } }],
      resolver,
    );
    expect(result.segments).toEqual([
      { type: 'mention', userId: 'native-123', displayName: 'alice' },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('warns for at_all', () => {
    const result = onebotSegmentsToUnified([{ type: 'at', data: { qq: 'all' } }], resolver);
    expect(result.segments).toEqual([]);
    expect(result.warnings).toEqual(['at_all_unsupported']);
  });

  it('warns for unknown users', () => {
    const result = onebotSegmentsToUnified([{ type: 'at', data: { qq: 999 } }], resolver);
    expect(result.segments).toEqual([]);
    expect(result.warnings).toEqual(['unknown_user:999']);
  });

  it('rejects images without an http url', () => {
    const result = onebotSegmentsToUnified([{ type: 'image', data: { file: 'a.png' } }], resolver);
    expect(result.segments).toEqual([]);
    expect(result.warnings).toEqual(['image_requires_url']);
  });

  it('accepts images with an http url', () => {
    const result = onebotSegmentsToUnified(
      [{ type: 'image', data: { file: 'a.png', url: 'https://cdn.example/a.png' } }],
      resolver,
    );
    expect(result.segments).toEqual([{ type: 'image', url: 'https://cdn.example/a.png' }]);
    expect(result.warnings).toEqual([]);
  });

  it('converts files with a filename and size', () => {
    const result = onebotSegmentsToUnified(
      [
        {
          type: 'file',
          data: { file: 'https://cdn.example/doc.pdf', name: 'doc.pdf', file_size: 2048 },
        },
      ],
      resolver,
    );
    expect(result.segments).toEqual([
      { type: 'file', url: 'https://cdn.example/doc.pdf', filename: 'doc.pdf', size: 2048 },
    ]);
  });

  it('warns when a file has no http url', () => {
    const result = onebotSegmentsToUnified([{ type: 'file', data: { file: 'doc.pdf' } }], resolver);
    expect(result.segments).toEqual([]);
    expect(result.warnings).toEqual(['file_requires_url']);
  });

  it('converts replies', () => {
    const result = onebotSegmentsToUnified([{ type: 'reply', data: { id: 'm-1' } }], resolver);
    expect(result.segments).toEqual([{ type: 'reply', messageId: 'm-1' }]);
  });

  it('warns for unsupported segments', () => {
    const segments: OneBotSegment[] = [{ type: 'face', data: { id: '1' } }];
    const result = onebotSegmentsToUnified(segments, resolver);
    expect(result.segments).toEqual([]);
    expect(result.warnings).toEqual(['unsupported_segment:face']);
  });

  it('unescapes CQ text and drops empty text', () => {
    const result = onebotSegmentsToUnified(
      [
        { type: 'text', data: { text: '' } },
        { type: 'text', data: { text: 'a&#91;b&#93;&#44;&amp;c' } },
      ],
      resolver,
    );
    expect(result.segments).toEqual([{ type: 'text', text: 'a[b],&c' }]);
  });

  it('reports warnings in segment order', () => {
    const result = onebotSegmentsToUnified(
      [
        { type: 'at', data: { qq: 'all' } },
        { type: 'face', data: { id: '1' } },
      ],
      resolver,
    );
    expect(result.warnings).toEqual(['at_all_unsupported', 'unsupported_segment:face']);
  });
});

describe('parseCqString', () => {
  it('parses an at segment followed by text', () => {
    expect(parseCqString('[CQ:at,qq=123] hi')).toEqual([
      { type: 'at', data: { qq: '123' } },
      { type: 'text', data: { text: ' hi' } },
    ]);
  });

  it('returns a single text segment for plain text', () => {
    expect(parseCqString('plain text')).toEqual([{ type: 'text', data: { text: 'plain text' } }]);
  });

  it('returns no segments for an empty message', () => {
    expect(parseCqString('')).toEqual([]);
  });

  it('parses image segments with a url', () => {
    expect(parseCqString('[CQ:image,file=a.png,url=https://cdn.example/a.png]')).toEqual([
      { type: 'image', data: { file: 'a.png', url: 'https://cdn.example/a.png' } },
    ]);
  });

  it('parses reply segments', () => {
    expect(parseCqString('[CQ:reply,id=4567]')).toEqual([{ type: 'reply', data: { id: '4567' } }]);
  });

  it('parses unknown segment types verbatim', () => {
    expect(parseCqString('[CQ:face,id=1]')).toEqual([{ type: 'face', data: { id: '1' } }]);
  });

  it('does not re-parse escaped CQ codes', () => {
    expect(parseCqString('&#91;CQ:at,qq=1&#93;')).toEqual([
      { type: 'text', data: { text: '[CQ:at,qq=1]' } },
    ]);
  });

  it('unescapes text around segments', () => {
    expect(parseCqString('a&#44;b[CQ:at,qq=1]c')).toEqual([
      { type: 'text', data: { text: 'a,b' } },
      { type: 'at', data: { qq: '1' } },
      { type: 'text', data: { text: 'c' } },
    ]);
  });
});

describe('decodeCqText', () => {
  it('restores escaped characters', () => {
    expect(decodeCqText('&#91;&#93;&#44;&amp;')).toBe('[],&');
  });

  it('is idempotent for plain text', () => {
    expect(decodeCqText('plain')).toBe('plain');
  });
});

describe('round trip through the normalizers', () => {
  it('keeps text content from a discord dm', () => {
    const inbound = normalizeDiscordMessage(
      {
        id: 'msg-rt',
        channelId: 'dm-rt',
        channelKind: 'dm',
        content: 'round trip',
        author: { id: 'user-rt', username: 'dave' },
        timestamp: '2026-01-02T00:00:00.000Z',
      },
      { now: NOW },
    );
    const onebot = unifiedToOneBotEvent(inbound, { selfId: 1, userId: 2 });
    expect(onebot.message).toEqual([{ type: 'text', data: { text: 'round trip' } }]);
  });
});

describe('expiring media metadata', () => {
  it('carries url_expires_at on image segments', () => {
    const segments = unifiedSegmentsToOneBotSegments([
      { type: 'image', url: 'https://cdn.test/a.png', urlExpiresAt: '2026-01-02T04:00:00.000Z' },
    ]);
    expect(segments[0]).toEqual({
      type: 'image',
      data: {
        file: 'https://cdn.test/a.png',
        url: 'https://cdn.test/a.png',
        url_expires_at: '2026-01-02T04:00:00.000Z',
      },
    });
  });

  it('carries url_expires_at and size on file segments', () => {
    const segments = unifiedSegmentsToOneBotSegments([
      {
        type: 'file',
        url: 'https://cdn.test/b.pdf',
        filename: 'b.pdf',
        size: 2_048,
        urlExpiresAt: '2026-01-02T05:00:00.000Z',
      },
    ]);
    expect(segments[0]).toEqual({
      type: 'file',
      data: {
        file: 'b.pdf',
        url: 'https://cdn.test/b.pdf',
        name: 'b.pdf',
        file_size: 2_048,
        url_expires_at: '2026-01-02T05:00:00.000Z',
      },
    });
  });

  it('omits the expiry key for permanent media', () => {
    const segments = unifiedSegmentsToOneBotSegments([
      { type: 'image', url: 'https://cdn.test/c.png' },
    ]);
    const data = (segments[0] as { data: Record<string, unknown> }).data;
    expect(data['url_expires_at']).toBeUndefined();
    expect(Object.keys(data).sort()).toEqual(['file', 'url']);
  });
});
