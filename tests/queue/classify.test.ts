import { describe, expect, it } from 'vitest';

import { classifyDeliveryError, redactText } from '@omni-relay/queue';
import { BridgeError } from '@omni-relay/shared-types';

describe('classifyDeliveryError', () => {
  it('keeps retryable bridge errors retryable', () => {
    const classified = classifyDeliveryError(
      new BridgeError({ code: 'rate_limited', message: 'slow down', retryAfterMs: 1_500 }),
    );

    expect(classified.permanent).toBe(false);
    expect(classified.failure).toEqual({
      kind: 'retryable',
      code: 'rate_limited',
      message: 'slow down',
      retryAfterMs: 1_500,
    });
  });

  it('marks permanent bridge errors permanent', () => {
    const classified = classifyDeliveryError(
      new BridgeError({ code: 'unauthorized', message: 'bad bot token' }),
    );

    expect(classified.permanent).toBe(true);
    expect(classified.failure).toEqual({
      kind: 'permanent',
      code: 'unauthorized',
      message: 'bad bot token',
    });
  });

  it('honours an explicit retryable override', () => {
    const classified = classifyDeliveryError(
      new BridgeError({ code: 'platform_rejected', message: 'try later', retryable: true }),
    );
    expect(classified.permanent).toBe(false);
    expect(classified.failure.kind).toBe('retryable');
  });

  it('treats plain errors as retryable and never leaks the stack', () => {
    const classified = classifyDeliveryError(new Error('socket hang up'));

    expect(classified.permanent).toBe(false);
    expect(classified.failure.kind).toBe('retryable');
    expect(classified.failure.code).toBe('unknown_error');
    expect(classified.failure.message).toBe('socket hang up');
    expect(classified.failure.message).not.toContain('at ');
  });

  it('treats non-error values as permanent internal failures', () => {
    for (const value of ['boom', 42, undefined, null]) {
      const classified = classifyDeliveryError(value);
      expect(classified.permanent).toBe(true);
      expect(classified.failure.kind).toBe('permanent');
      expect(classified.failure.code).toBe('internal');
    }

    expect(classifyDeliveryError('boom').failure.message).toBe('boom');
    expect(classifyDeliveryError({ weird: true }).failure.message).toBe('[object Object]');
  });

  it('redacts credentials from error messages', () => {
    const classified = classifyDeliveryError(
      new BridgeError({
        code: 'platform_unavailable',
        message: 'request failed: Bearer abc.def-123 token=super-secret secret=s3cr3t-value',
      }),
    );

    expect(classified.failure.message).not.toContain('abc.def-123');
    expect(classified.failure.message).not.toContain('super-secret');
    expect(classified.failure.message).not.toContain('s3cr3t-value');
    expect(classified.failure.message).toContain('[redacted]');
  });

  it('truncates very long messages', () => {
    const classified = classifyDeliveryError(new Error('x'.repeat(5_000)));
    expect(classified.failure.message.length).toBeLessThanOrEqual(501);
    expect(classified.failure.message.endsWith('…')).toBe(true);
  });
});

describe('redactText', () => {
  it('normalises whitespace and redacts secrets', () => {
    expect(redactText('Bearer 12345')).toBe('[redacted]');
    expect(redactText('Authorization: Bearer 12345')).toBe('Authorization: [redacted]');
    expect(redactText('url?token=abc&x=1')).toBe('url?[redacted]');
    expect(redactText('secret=abc')).toBe('[redacted]');
    expect(redactText('line one\nline two')).toBe('line one line two');
  });
});
