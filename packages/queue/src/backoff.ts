import type { RetryPolicyConfig } from '@omni-relay/shared-types';

function clampSample(sample: number): number {
  if (!Number.isFinite(sample)) {
    return 0;
  }
  return Math.min(Math.max(sample, 0), 1);
}

/**
 * Exponential backoff with symmetric jitter.
 *
 * `delay = initialDelayMs * 2^(attempt-1)`, capped at `maxDelayMs`, then
 * multiplied by `1 + jitterRatio * (rng()*2 - 1)`. `attempt` is 1-based.
 */
export function computeBackoff(
  attempt: number,
  policy: RetryPolicyConfig,
  rng: () => number = Math.random,
): number {
  const safeAttempt = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const initialDelayMs =
    Number.isFinite(policy.initialDelayMs) && policy.initialDelayMs > 0 ? policy.initialDelayMs : 0;
  const maxDelayMs =
    Number.isFinite(policy.maxDelayMs) && policy.maxDelayMs >= 0
      ? policy.maxDelayMs
      : initialDelayMs;
  const jitterRatio = Number.isFinite(policy.jitterRatio)
    ? Math.min(Math.max(policy.jitterRatio, 0), 1)
    : 0;

  const exponential = initialDelayMs * 2 ** (safeAttempt - 1);
  const capped = Math.min(exponential, maxDelayMs);
  const jitterFactor = 1 + jitterRatio * (clampSample(rng()) * 2 - 1);
  return Math.max(0, Math.round(capped * jitterFactor));
}
