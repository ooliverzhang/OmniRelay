import { describe, expect, it } from 'vitest';

import { computeBackoff } from '@omni-relay/queue';
import type { RetryPolicyConfig } from '@omni-relay/shared-types';

const POLICY: RetryPolicyConfig = {
  maxAttempts: 5,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
};

const NO_JITTER: RetryPolicyConfig = { ...POLICY, jitterRatio: 0 };
const mid = (): number => 0.5;

describe('computeBackoff', () => {
  it('doubles the delay per attempt', () => {
    expect(computeBackoff(1, NO_JITTER, mid)).toBe(1_000);
    expect(computeBackoff(2, NO_JITTER, mid)).toBe(2_000);
    expect(computeBackoff(3, NO_JITTER, mid)).toBe(4_000);
    expect(computeBackoff(4, NO_JITTER, mid)).toBe(8_000);
  });

  it('caps the delay at maxDelayMs', () => {
    expect(computeBackoff(10, NO_JITTER, mid)).toBe(60_000);
    expect(computeBackoff(100, NO_JITTER, mid)).toBe(60_000);
  });

  it('applies symmetric jitter', () => {
    expect(computeBackoff(1, POLICY, () => 0)).toBe(800);
    expect(computeBackoff(1, POLICY, () => 1)).toBe(1_200);
    expect(computeBackoff(1, POLICY, mid)).toBe(1_000);
  });

  it('stays monotonic across attempts', () => {
    let previous = -1;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const delay = computeBackoff(attempt, NO_JITTER, mid);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });

  it('treats attempt 0 and negative attempts as the first attempt', () => {
    expect(computeBackoff(0, NO_JITTER, mid)).toBe(1_000);
    expect(computeBackoff(-3, NO_JITTER, mid)).toBe(1_000);
  });

  it('never returns a negative or fractional delay', () => {
    const aggressive: RetryPolicyConfig = {
      maxAttempts: 3,
      initialDelayMs: 0,
      maxDelayMs: 1_000,
      jitterRatio: 1,
    };
    expect(computeBackoff(1, aggressive, () => 0)).toBe(0);
    expect(calculateInteger(computeBackoff(3, POLICY))).toBe(true);
  });

  it('defaults the random source to Math.random', () => {
    const delay = computeBackoff(3, POLICY);
    // attempt 3 => 4000ms, jitter ±20%
    expect(delay).toBeGreaterThanOrEqual(3_200);
    expect(delay).toBeLessThanOrEqual(4_800);
    expect(Number.isInteger(delay)).toBe(true);
  });
});

function calculateInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
