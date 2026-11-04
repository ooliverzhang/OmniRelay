import type { UnifiedSegment } from '@omni-relay/shared-types';

/** Default budget for {@link summarizeSegments}; keeps log lines readable. */
const DEFAULT_SUMMARY_LENGTH = 200;

/** Truncates `text` to `maxLength` characters, appending `…` when shortened. */
export function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength === 1) {
    return '…';
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

/** Segment type list, e.g. `['text', 'image']`. */
export function segmentTypeList(segments: readonly UnifiedSegment[]): string[] {
  return segments.map((segment) => segment.type);
}

/**
 * Single-line summary of a message for logs, e.g. `[text] hi [image]`.
 * Only text segments carry their content; other segments are type markers.
 */
export function summarizeSegments(
  segments: readonly UnifiedSegment[],
  maxLength = DEFAULT_SUMMARY_LENGTH,
): string {
  const parts: string[] = [];
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        parts.push(segment.text.length > 0 ? `[text] ${segment.text}` : '[text]');
        break;
      case 'mention':
        parts.push(`[mention] @${segment.displayName ?? segment.userId}`);
        break;
      default:
        parts.push(`[${segment.type}]`);
    }
  }
  return truncate(parts.join(' '), maxLength);
}
