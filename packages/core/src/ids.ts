import { createHash, randomBytes } from 'node:crypto';

import type { Platform } from '@omni-relay/shared-types';

/** Builds a random, prefixed event identifier: `evt_<32 hex chars>`. */
export function createEventId(prefix = 'evt'): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

/**
 * Builds a bridge message id.
 *
 * With a native message id the id is derived from a SHA-1 digest so retries and
 * reconnects map onto the same bridge key; without one a random suffix is used.
 */
export function createBridgeMessageId(platform: Platform, nativeMessageId?: string): string {
  if (nativeMessageId === undefined || nativeMessageId.length === 0) {
    return `brg_${platform}_${randomBytes(8).toString('hex')}`;
  }
  const hash = createHash('sha1').update(nativeMessageId).digest('hex').slice(0, 16);
  return `brg_${platform}_${hash}`;
}
