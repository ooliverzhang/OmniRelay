import {
  CAPABILITY_FLAGS,
  BridgeError,
  CONSERVATIVE_CAPABILITIES,
  type CapabilityFlag,
  type ConversationKind,
  type Platform,
  type PlatformCapabilities,
} from '@omni-relay/shared-types';

/**
 * Verified baseline capability matrix.
 *
 * - Discord: guild channels and DMs are fully readable/writable, but a bot
 *   cannot open a DM with a user it does not share a guild with, so
 *   `privateProactiveSend` stays false.
 * - QQ official bot: only @-mentions are pushed for groups by default, and
 *   broadcasting is never available.
 */
export const DEFAULT_CAPABILITIES: Record<Platform, PlatformCapabilities> = {
  discord: {
    privateReceive: true,
    privateReply: true,
    privateProactiveSend: false,
    groupReceive: true,
    groupMentionReceive: true,
    groupReply: true,
    groupProactiveSend: true,
    broadcast: false,
  },
  'qq-official': {
    privateReceive: true,
    privateReply: true,
    privateProactiveSend: true,
    groupReceive: false,
    groupMentionReceive: true,
    groupReply: true,
    groupProactiveSend: true,
    broadcast: false,
  },
};

export type CapabilityOverrides = Partial<Record<Platform, Partial<PlatformCapabilities>>>;

export function mergeCapabilities(
  base: PlatformCapabilities,
  override?: Partial<PlatformCapabilities> | undefined,
): PlatformCapabilities {
  const merged: PlatformCapabilities = { ...base };
  if (override) {
    for (const flag of CAPABILITY_FLAGS) {
      const value = override[flag];
      if (typeof value === 'boolean') {
        merged[flag] = value;
      }
    }
  }
  return merged;
}

export function resolveCapabilities(
  platform: Platform,
  overrides?: CapabilityOverrides | undefined,
): PlatformCapabilities {
  return mergeCapabilities(DEFAULT_CAPABILITIES[platform], overrides?.[platform]);
}

export function isCapabilityEnabled(
  capabilities: PlatformCapabilities,
  flag: CapabilityFlag,
): boolean {
  return capabilities[flag] === true;
}

export function assertCapability(
  capabilities: PlatformCapabilities,
  flag: CapabilityFlag,
  context?: string,
): void {
  if (!isCapabilityEnabled(capabilities, flag)) {
    throw new BridgeError({
      code: 'capability_unsupported',
      message: `Platform does not support capability "${flag}"${context ? ` (${context})` : ''}`,
      retryable: false,
      details: { capability: flag },
    });
  }
}

export interface DeliveryCapabilityQuery {
  conversationKind: ConversationKind;
  proactive: boolean;
}

export interface DeliveryCapabilityResult {
  allowed: boolean;
  reason: string | null;
  requiredFlag: CapabilityFlag | null;
}

/** Pure check used by the delivery planner before anything is queued. */
export function checkDeliveryCapability(
  capabilities: PlatformCapabilities,
  query: DeliveryCapabilityQuery,
): DeliveryCapabilityResult {
  const requiredFlag = resolveRequiredFlag(query);
  if (!requiredFlag) {
    return { allowed: false, reason: `unsupported_conversation_kind:${query.conversationKind}`, requiredFlag: null };
  }
  if (!capabilities[requiredFlag]) {
    return { allowed: false, reason: `capability_unsupported:${requiredFlag}`, requiredFlag };
  }
  return { allowed: true, reason: null, requiredFlag };
}

function resolveRequiredFlag(query: DeliveryCapabilityQuery): CapabilityFlag | null {
  if (query.conversationKind === 'private') {
    return query.proactive ? 'privateProactiveSend' : 'privateReply';
  }
  if (query.conversationKind === 'group') {
    return query.proactive ? 'groupProactiveSend' : 'groupReply';
  }
  if (query.conversationKind === 'channel') {
    return query.proactive ? 'groupProactiveSend' : 'groupReply';
  }
  return null;
}

export interface CapabilityDescription {
  flag: CapabilityFlag;
  supported: boolean;
}

export function describeCapabilities(capabilities: PlatformCapabilities): CapabilityDescription[] {
  return CAPABILITY_FLAGS.map((flag) => ({ flag, supported: capabilities[flag] === true }));
}

export function missingCapabilities(
  capabilities: PlatformCapabilities,
): CapabilityFlag[] {
  return CAPABILITY_FLAGS.filter((flag) => capabilities[flag] !== true);
}

export { CONSERVATIVE_CAPABILITIES };
