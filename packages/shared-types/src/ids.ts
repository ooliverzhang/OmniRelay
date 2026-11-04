import type { Platform } from './platform.js';

/**
 * Native identifier kinds. A Discord channel is a `channel` natively but maps
 * onto a OneBot `group`, which is why native kind and OneBot kind differ.
 */
export const NATIVE_ID_KINDS = ['user', 'group', 'channel'] as const;

export type NativeIdKind = (typeof NATIVE_ID_KINDS)[number];

export const ONEBOT_ID_KINDS = ['user', 'group'] as const;

export type OneBotIdKind = (typeof ONEBOT_ID_KINDS)[number];

export interface IdMapping {
  platform: Platform;
  nativeKind: NativeIdKind;
  nativeId: string;
  onebotKind: OneBotIdKind;
  onebotId: number;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
}

/** Stable composite key: `discord:user:123456789`. */
export function nativeKey(platform: Platform, kind: NativeIdKind, nativeId: string): string {
  return `${platform}:${kind}:${nativeId}`;
}

export function parseNativeKey(key: string): {
  platform: string;
  nativeKind: string;
  nativeId: string;
} | null {
  const first = key.indexOf(':');
  const second = key.indexOf(':', first + 1);
  if (first <= 0 || second <= first + 1 || second === key.length - 1) {
    return null;
  }
  return {
    platform: key.slice(0, first),
    nativeKind: key.slice(first + 1, second),
    nativeId: key.slice(second + 1),
  };
}

export function onebotKey(kind: OneBotIdKind, onebotId: number): string {
  return `${kind}:${onebotId}`;
}

/** OneBot id allocation ranges, kept disjoint per kind. */
export const ONEBOT_ID_RANGES: Record<OneBotIdKind, { min: number; max: number }> = {
  user: { min: 1_000_000_001, max: 1_999_999_999 },
  group: { min: 2_000_000_001, max: 2_999_999_999 },
};

export function nativeKindToOneBotKind(kind: NativeIdKind): OneBotIdKind {
  return kind === 'user' ? 'user' : 'group';
}
