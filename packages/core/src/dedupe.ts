/** Stable dedupe key for an inbound Discord message. */
export function discordDedupeKey(messageId: string): string {
  return `discord:${messageId}`;
}

/** Stable dedupe key for an inbound QQ official message, disambiguated by `msgSeq`. */
export function qqDedupeKey(messageId: string, msgSeq?: string | number | null): string {
  return `qq:${messageId}:${msgSeq ?? 0}`;
}
