import { describe, expect, it } from 'vitest';

import { createBridgeMessageId, normalizeDiscordMessage } from '@omni-relay/core';
import type { UnifiedSegment } from '@omni-relay/shared-types';

const NOW = (): Date => new Date('2026-01-02T03:04:05.000Z');

function textOf(segments: readonly UnifiedSegment[]): string {
  return segments
    .filter(
      (segment): segment is Extract<UnifiedSegment, { type: 'text' }> => segment.type === 'text',
    )
    .map((segment) => segment.text)
    .join('');
}

describe('normalizeDiscordMessage', () => {
  it('maps a DM onto a private conversation', () => {
    const event = normalizeDiscordMessage(
      {
        id: 'msg-1',
        channelId: 'dm-1',
        channelKind: 'dm',
        content: 'hello there',
        author: { id: 'user-1', username: 'alice' },
        timestamp: '2026-01-02T00:00:00.000Z',
      },
      { now: NOW },
    );

    expect(event.platform).toBe('discord');
    expect(event.conversation).toEqual({ kind: 'private', nativeId: 'user-1' });
    expect(event.sender).toMatchObject({
      nativeId: 'user-1',
      displayName: 'alice',
      username: 'alice',
      isBot: false,
    });
    expect(event.message).toEqual([{ type: 'text', text: 'hello there' }]);
    expect(event.mentionsBot).toBe(false);
    expect(event.timestamp).toBe('2026-01-02T00:00:00.000Z');
    expect(event.replyContext).toBeUndefined();
    expect(event.meta).toMatchObject({
      origin: 'discord',
      nativeMessageId: 'msg-1',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    expect(event.meta.bridgeMessageId).toBe(createBridgeMessageId('discord', 'msg-1'));
  });

  it('maps a guild message with mentions and strips the markers', () => {
    const event = normalizeDiscordMessage(
      {
        id: 'msg-2',
        channelId: 'chan-9',
        guildId: 'guild-7',
        channelKind: 'guild',
        channelName: 'general',
        content: 'hi <@111> and <@!222> in <#333>',
        author: { id: 'user-2', username: 'bob', globalName: 'Bobby' },
        mentions: [{ id: '111', username: 'alice' }],
        timestamp: 1_700_000_000_000,
        isBotMentioned: true,
      },
      { now: NOW },
    );

    expect(event.conversation).toEqual({
      kind: 'group',
      nativeId: 'chan-9',
      displayName: 'general',
      parentNativeId: 'guild-7',
    });
    expect(event.sender).toMatchObject({ displayName: 'Bobby', username: 'bob', isBot: false });
    expect(event.message).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'mention', userId: '111', displayName: 'alice' },
      { type: 'text', text: ' and ' },
      { type: 'mention', userId: '222' },
      { type: 'text', text: ' in ' },
      { type: 'mention', userId: '333' },
    ]);
    expect(textOf(event.message)).not.toContain('<@');
    expect(textOf(event.message)).not.toContain('<#');
    expect(event.mentionsBot).toBe(true);
    expect(event.timestamp).toBe('2023-11-14T22:13:20.000Z');
  });

  it('keeps the text after a leading mention', () => {
    const event = normalizeDiscordMessage(
      {
        id: 'msg-3',
        channelId: 'chan-1',
        channelKind: 'guild',
        content: '<@123> ping',
        author: { id: 'user-3' },
        timestamp: '2026-01-02T00:00:00.000Z',
      },
      { now: NOW },
    );
    expect(event.message).toEqual([
      { type: 'mention', userId: '123' },
      { type: 'text', text: ' ping' },
    ]);
  });

  it('detects a bot mention from the mention list when the flag is absent', () => {
    const event = normalizeDiscordMessage(
      {
        id: 'msg-4',
        channelId: 'chan-1',
        channelKind: 'guild',
        content: 'hey team',
        author: { id: 'user-4' },
        timestamp: '2026-01-02T00:00:00.000Z',
        botUserId: '999',
        mentions: [{ id: '999', username: 'omni' }],
      },
      { now: NOW },
    );
    expect(event.mentionsBot).toBe(true);
  });

  it('detects a bot mention from the raw content', () => {
    const event = normalizeDiscordMessage(
      {
        id: 'msg-5',
        channelId: 'chan-1',
        channelKind: 'guild',
        content: 'hey <@!999>',
        author: { id: 'user-5' },
        timestamp: '2026-01-02T00:00:00.000Z',
        botUserId: '999',
      },
      { now: NOW },
    );
    expect(event.mentionsBot).toBe(true);
  });

  it('respects an explicit isBotMentioned=false', () => {
    const event = normalizeDiscordMessage(
      {
        id: 'msg-6',
        channelId: 'chan-1',
        channelKind: 'guild',
        content: 'hey <@999>',
        author: { id: 'user-6' },
        timestamp: '2026-01-02T00:00:00.000Z',
        botUserId: '999',
        isBotMentioned: false,
      },
      { now: NOW },
    );
    expect(event.mentionsBot).toBe(false);
  });

  it('maps attachments to image and file segments', () => {
    const event = normalizeDiscordMessage(
      {
        id: 'msg-7',
        channelId: 'chan-1',
        channelKind: 'guild',
        content: '',
        author: { id: 'user-7', bot: true },
        timestamp: '2026-01-02T00:00:00.000Z',
        attachments: [
          {
            id: 'att-1',
            url: 'https://cdn.example/img.png',
            filename: 'img.png',
            contentType: 'image/png',
            width: 10,
            height: 20,
          },
          {
            id: 'att-2',
            url: 'https://cdn.example/doc.pdf',
            contentType: 'application/pdf',
            size: 42,
          },
          { url: 'https://cdn.example/raw.bin' },
        ],
      },
      { now: NOW },
    );

    expect(event.message).toEqual([
      {
        type: 'image',
        url: 'https://cdn.example/img.png',
        filename: 'img.png',
        width: 10,
        height: 20,
      },
      { type: 'file', url: 'https://cdn.example/doc.pdf', filename: 'att-2', size: 42 },
      { type: 'file', url: 'https://cdn.example/raw.bin', filename: '2' },
    ]);
    expect(event.sender.isBot).toBe(true);
  });

  it('records reply context for referenced messages', () => {
    const event = normalizeDiscordMessage(
      {
        id: 'msg-8',
        channelId: 'chan-1',
        channelKind: 'guild',
        content: 'replying',
        author: { id: 'user-8' },
        timestamp: '2026-01-02T00:00:00.000Z',
        referencedMessageId: 'msg-0',
      },
      { now: NOW },
    );
    expect(event.replyContext).toEqual({ nativeMessageId: 'msg-0', canReply: true });
  });

  it('keeps a caller supplied event id', () => {
    const event = normalizeDiscordMessage(
      {
        id: 'msg-9',
        channelId: 'chan-1',
        channelKind: 'guild',
        content: 'x',
        author: { id: 'user-9' },
        timestamp: '2026-01-02T00:00:00.000Z',
        eventId: 'evt_fixed',
      },
      { now: NOW },
    );
    expect(event.eventId).toBe('evt_fixed');
  });
});
