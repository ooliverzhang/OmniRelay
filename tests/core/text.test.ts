import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  segmentTypeList,
  summarizeSegments,
  truncate,
  unifiedMessageKind,
} from '@omni-relay/core';
import type { UnifiedSegment } from '@omni-relay/shared-types';

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('appends an ellipsis when trimming', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
    expect(truncate('hello world', 8)).toHaveLength(8);
  });

  it('handles degenerate budgets', () => {
    expect(truncate('hello', 0)).toBe('');
    expect(truncate('hello', 1)).toBe('…');
    expect(truncate('ab', 2)).toBe('ab');
  });
});

describe('segmentTypeList', () => {
  it('lists segment types in order', () => {
    const segments: UnifiedSegment[] = [
      { type: 'text', text: 'hi' },
      { type: 'image', url: 'https://cdn.example/a.png' },
      { type: 'reply', messageId: 'm-1' },
    ];
    expect(segmentTypeList(segments)).toEqual(['text', 'image', 'reply']);
  });
});

describe('summarizeSegments', () => {
  it('renders a compact summary', () => {
    const segments: UnifiedSegment[] = [
      { type: 'text', text: 'hi' },
      { type: 'image', url: 'https://cdn.example/a.png' },
    ];
    expect(summarizeSegments(segments)).toBe('[text] hi [image]');
  });

  it('includes the mention target and truncates to the budget', () => {
    const segments: UnifiedSegment[] = [
      { type: 'mention', userId: '42', displayName: 'alice' },
      { type: 'text', text: 'hello there' },
    ];
    expect(summarizeSegments(segments, 10)).toBe('[mention]…');
  });

  it('handles empty messages', () => {
    expect(summarizeSegments([])).toBe('');
  });

  it('keeps the redacted placeholder intact', () => {
    expect(summarizeSegments([{ type: 'text', text: REDACTED }])).toBe(`[text] ${REDACTED}`);
  });
});

describe('unifiedMessageKind', () => {
  it('treats an empty message as text', () => {
    expect(unifiedMessageKind([])).toBe('text');
  });

  it('treats text and mentions as text', () => {
    expect(
      unifiedMessageKind([
        { type: 'mention', userId: '1' },
        { type: 'text', text: 'hi' },
      ]),
    ).toBe('text');
  });

  it('detects pure images and pure files', () => {
    expect(unifiedMessageKind([{ type: 'image', url: 'https://cdn.example/a.png' }])).toBe('image');
    expect(
      unifiedMessageKind([{ type: 'file', url: 'https://cdn.example/a.txt', filename: 'a.txt' }]),
    ).toBe('file');
  });

  it('reports mixed content', () => {
    expect(
      unifiedMessageKind([
        { type: 'text', text: 'hi' },
        { type: 'image', url: 'https://cdn.example/a.png' },
      ]),
    ).toBe('mixed');
  });

  it('ignores reply segments', () => {
    expect(unifiedMessageKind([{ type: 'reply', messageId: 'm-1' }])).toBe('text');
    expect(
      unifiedMessageKind([
        { type: 'reply', messageId: 'm-1' },
        { type: 'image', url: 'https://cdn.example/a.png' },
      ]),
    ).toBe('image');
  });
});
