import { describe, expect, it } from 'vitest';

import { createBridgeMessageId, normalizeQqMessage, qqDedupeKey } from '@omni-relay/core';

const NOW = (): Date => new Date('2026-01-02T03:04:05.000Z');

describe('normalizeQqMessage', () => {
  it('maps a c2c message onto a private conversation', () => {
    const event = normalizeQqMessage(
      {
        id: 'qq-msg-1',
        msgSeq: '3',
        kind: 'c2c',
        userOpenId: 'open-user-1',
        content: 'hello',
        timestamp: 1_700_000_000,
        memberRole: 'member',
        userName: 'carol',
      },
      { now: NOW },
    );

    expect(event.platform).toBe('qq-official');
    expect(event.conversation).toEqual({
      kind: 'private',
      nativeId: 'open-user-1',
      displayName: 'carol',
    });
    expect(event.sender).toMatchObject({
      nativeId: 'open-user-1',
      role: 'member',
      displayName: 'carol',
    });
    expect(event.message).toEqual([{ type: 'text', text: 'hello' }]);
    expect(event.mentionsBot).toBe(false);
    expect(event.timestamp).toBe('2023-11-14T22:13:20.000Z');
    expect(event.meta).toMatchObject({
      origin: 'qq-official',
      nativeMessageId: 'qq-msg-1',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    expect(event.meta.bridgeMessageId).toBe(
      createBridgeMessageId('qq-official', qqDedupeKey('qq-msg-1', '3')),
    );
  });

  it('maps a group message onto a group conversation', () => {
    const event = normalizeQqMessage(
      {
        id: 'qq-msg-2',
        kind: 'group',
        groupOpenId: 'open-group-1',
        groupName: 'ops',
        userOpenId: 'open-user-2',
        content: 'build failed',
        timestamp: '2026-01-02T00:00:00.000Z',
        memberRole: 'admin',
        mentionsBot: true,
      },
      { now: NOW },
    );

    expect(event.conversation).toEqual({
      kind: 'group',
      nativeId: 'open-group-1',
      displayName: 'ops',
    });
    expect(event.sender.role).toBe('admin');
    expect(event.mentionsBot).toBe(true);
    expect(event.meta.bridgeMessageId).toBe(
      createBridgeMessageId('qq-official', qqDedupeKey('qq-msg-2', undefined)),
    );
  });

  it('rejects a group message without a group open id', () => {
    expect(() =>
      normalizeQqMessage(
        {
          id: 'qq-msg-3',
          kind: 'group',
          userOpenId: 'open-user-3',
          content: 'no group id',
          timestamp: '2026-01-02T00:00:00.000Z',
        },
        { now: NOW },
      ),
    ).toThrow(/groupOpenId/);
  });

  it('maps image attachments with their expiry', () => {
    const event = normalizeQqMessage(
      {
        id: 'qq-msg-4',
        kind: 'c2c',
        userOpenId: 'open-user-4',
        content: '',
        timestamp: '2026-01-02T00:00:00.000Z',
        attachments: [
          {
            url: 'https://qq.example/img.png',
            contentType: 'image/png',
            width: 64,
            height: 32,
            urlExpiresAt: '2026-01-02T04:00:00.000Z',
          },
        ],
      },
      { now: NOW },
    );

    expect(event.message).toEqual([
      {
        type: 'image',
        url: 'https://qq.example/img.png',
        width: 64,
        height: 32,
        urlExpiresAt: '2026-01-02T04:00:00.000Z',
      },
    ]);
  });

  it('maps file attachments and derives a filename', () => {
    const event = normalizeQqMessage(
      {
        id: 'qq-msg-5',
        kind: 'group',
        groupOpenId: 'open-group-5',
        userOpenId: 'open-user-5',
        content: '',
        timestamp: '2026-01-02T00:00:00.000Z',
        attachments: [{ url: 'https://qq.example/files/report.pdf', size: 1024 }],
      },
      { now: NOW },
    );

    expect(event.message).toEqual([
      {
        type: 'file',
        url: 'https://qq.example/files/report.pdf',
        filename: 'report.pdf',
        size: 1024,
      },
    ]);
  });

  it('defaults the sender role to unknown', () => {
    const event = normalizeQqMessage(
      {
        id: 'qq-msg-6',
        kind: 'c2c',
        userOpenId: 'open-user-6',
        content: 'hi',
        timestamp: '2026-01-02T00:00:00.000Z',
      },
      { now: NOW },
    );
    expect(event.sender.role).toBe('unknown');
  });
});
