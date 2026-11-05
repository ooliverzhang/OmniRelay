import type {
  OneBotAtSegment,
  OneBotFileSegment,
  OneBotImageSegment,
  OneBotMessageEvent,
  OneBotSegment,
  UnifiedMessageEvent,
  UnifiedSegment,
} from '@omni-relay/shared-types';

export interface UnifiedToOneBotOptions {
  selfId: number;
  userId: number;
  groupId?: number | null;
  resolveMentionUserId?: (nativeUserId: string) => number | null;
  now?: () => Date;
}

/** Projects a unified inbound event onto a OneBot 11 message event. */
export function unifiedToOneBotEvent(
  event: UnifiedMessageEvent,
  options: UnifiedToOneBotOptions,
): OneBotMessageEvent {
  const isPrivate = event.conversation.kind === 'private';
  const result: OneBotMessageEvent = {
    time: toEpochSeconds(event.timestamp, options.now),
    self_id: options.selfId,
    post_type: 'message',
    message_type: isPrivate ? 'private' : 'group',
    sub_type: isPrivate ? 'friend' : 'normal',
    message_id: event.meta.nativeMessageId ?? event.eventId,
    user_id: options.userId,
    message: unifiedSegmentsToOneBotSegments(event.message, options),
  };
  const groupId = options.groupId;
  if (!isPrivate && groupId !== undefined && groupId !== null) {
    result.group_id = groupId;
  }
  return result;
}

/**
 * Converts unified segments into OneBot segments.
 *
 * Shared by the inbound projection and by `get_msg`, which replays a stored
 * message back to the host.
 */
export function unifiedSegmentsToOneBotSegments(
  segments: readonly UnifiedSegment[],
  options: Pick<UnifiedToOneBotOptions, 'resolveMentionUserId'> = {},
): OneBotSegment[] {
  const converted: OneBotSegment[] = [];
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        if (segment.text.length > 0) {
          converted.push({ type: 'text', data: { text: segment.text } });
        }
        break;
      case 'mention': {
        const onebotId = options.resolveMentionUserId?.(segment.userId) ?? null;
        if (onebotId !== null) {
          const at: OneBotAtSegment = { type: 'at', data: { qq: onebotId } };
          converted.push(at);
        }
        break;
      }
      case 'image': {
        const data: OneBotImageSegment['data'] = { file: segment.url, url: segment.url };
        if (segment.urlExpiresAt !== undefined) {
          data.url_expires_at = segment.urlExpiresAt;
        }
        converted.push({ type: 'image', data });
        break;
      }
      case 'file': {
        const data: OneBotFileSegment['data'] = {
          file: segment.filename,
          url: segment.url,
          name: segment.filename,
        };
        if (segment.size !== undefined) {
          data.file_size = segment.size;
        }
        if (segment.urlExpiresAt !== undefined) {
          data.url_expires_at = segment.urlExpiresAt;
        }
        const file: OneBotFileSegment = { type: 'file', data };
        converted.push(file);
        break;
      }
      case 'reply':
        converted.push({ type: 'reply', data: { id: segment.messageId } });
        break;
    }
  }
  return converted;
}

function toEpochSeconds(timestamp: string, now?: () => Date): number {
  const parsed = new Date(timestamp).getTime();
  if (Number.isNaN(parsed)) {
    return Math.floor((now?.() ?? new Date()).getTime() / 1000);
  }
  return Math.floor(parsed / 1000);
}
