import type { MessageKind, UnifiedSegment } from '@omni-relay/shared-types';

/**
 * Classifies a message by segment composition.
 *
 * `text` and `mention` both count as text; reply segments are neutral. An empty
 * message is reported as `text` so that rules relying on the default kind still
 * match plain text chatter.
 */
export function unifiedMessageKind(segments: readonly UnifiedSegment[]): MessageKind {
  const kinds = new Set<'text' | 'image' | 'file'>();
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
      case 'mention':
        kinds.add('text');
        break;
      case 'image':
        kinds.add('image');
        break;
      case 'file':
        kinds.add('file');
        break;
      case 'reply':
        break;
    }
  }
  if (kinds.size === 0) {
    return 'text';
  }
  if (kinds.size > 1) {
    return 'mixed';
  }
  const [only] = kinds;
  return only ?? 'text';
}
