import type {
  ConversationKind,
  DeliveryAttemptRecord,
  DeliveryStatus,
  DeadLetterRecord,
  FailureInfo,
  IdMapping,
  MessageRule,
  MessageStatus,
  MessageTrendPoint,
  NativeIdKind,
  OneBotIdKind,
  OutboxRecord,
  OutgoingMessage,
  Platform,
  PlatformCount,
  RateLimitDecision,
  RateLimitScope,
  UnifiedSegment,
} from '@omni-relay/shared-types';

/**
 * Internal contract between the storage layer and every consumer.
 *
 * Implemented by `openStorage()` in `./storage.ts`. All methods are synchronous
 * because they are backed by the built-in `node:sqlite` driver.
 */

export interface StorageLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface OpenStorageOptions {
  /** Path of the SQLite file, `:memory:` for tests. */
  sqlitePath: string;
  logger?: StorageLogger;
  /** Injectable clock, useful for retention/dedupe tests. */
  now?: () => Date;
  /** Skip running migrations automatically. */
  skipMigrate?: boolean;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface PageParams {
  page: number;
  pageSize: number;
}

export function normalizePage(query: PageQuery): PageParams {
  const page = Number.isFinite(query.page) && (query.page ?? 0) > 0 ? Math.floor(query.page as number) : 1;
  const rawSize = Number.isFinite(query.pageSize) && (query.pageSize ?? 0) > 0 ? Math.floor(query.pageSize as number) : 25;
  const pageSize = Math.min(Math.max(rawSize, 1), 200);
  return { page, pageSize };
}

// ---------------------------------------------------------------------------
// id mappings
// ---------------------------------------------------------------------------

export interface GetOrCreateMappingInput {
  platform: Platform;
  nativeKind: NativeIdKind;
  nativeId: string;
  displayName?: string | undefined;
}

export interface IdMappingRepo {
  /** Allocates a stable OneBot id on first use; never reuses a retired id. */
  getOrCreate(input: GetOrCreateMappingInput): IdMapping;
  get(platform: Platform, nativeKind: NativeIdKind, nativeId: string): IdMapping | null;
  getByOneBotId(kind: OneBotIdKind, onebotId: number): IdMapping | null;
  updateDisplayName(
    platform: Platform,
    nativeKind: NativeIdKind,
    nativeId: string,
    displayName: string,
  ): void;
  list(
    query: PageQuery & { platform?: Platform | undefined; nativeKind?: NativeIdKind | undefined; search?: string | undefined },
  ): Paged<IdMapping>;
  count(): number;
}

// ---------------------------------------------------------------------------
// inbound dedupe
// ---------------------------------------------------------------------------

export interface DedupeRepo {
  /** Returns `true` when the key is new, `false` when it was already seen. */
  markSeen(key: string, options?: { ttlSeconds?: number | undefined; now?: Date | undefined }): boolean;
  has(key: string): boolean;
  prune(now?: Date): number;
  size(): number;
}

// ---------------------------------------------------------------------------
// outbox
// ---------------------------------------------------------------------------

export interface EnqueueOutboxInput {
  platform: Platform;
  conversationKind: ConversationKind;
  conversationNativeId: string;
  senderNativeId: string;
  payload: OutgoingMessage;
  bridgeMessageId: string;
  ruleId?: string | undefined;
  maxAttempts?: number | undefined;
  nextAttemptAt?: Date | undefined;
}

export interface OutboxStats {
  queued: number;
  sending: number;
  retrying: number;
  dead: number;
  sent24h: number;
  failed24h: number;
}

export interface OutboxRepo {
  enqueue(input: EnqueueOutboxInput): OutboxRecord;
  get(id: string): OutboxRecord | null;
  /**
   * Atomically moves due `queued`/`retrying` records into `sending` and returns
   * them. Claiming is what prevents two workers from sending the same record.
   */
  claimDue(options?: { limit?: number | undefined; now?: Date | undefined }): OutboxRecord[];
  markSent(id: string, info?: { nativeMessageId?: string | undefined; now?: Date | undefined }): void;
  markRetry(id: string, input: { failure: FailureInfo; nextAttemptAt: Date; now?: Date | undefined }): void;
  /** Moves the record into `dead_letters` and deletes it from the outbox. */
  markDead(id: string, input: { failure: FailureInfo; now?: Date | undefined }): DeadLetterRecord;
  requeue(id: string, now?: Date): boolean;
  delete(id: string): boolean;
  list(
    query: PageQuery & { status?: DeliveryStatus | undefined; platform?: Platform | undefined },
  ): Paged<OutboxRecord>;
  stats(now?: Date): OutboxStats;
  dueCount(now?: Date): number;
  countByStatus(): Partial<Record<DeliveryStatus, number>>;
}

export interface DeliveryAttemptRepo {
  record(input: {
    outboxId: string;
    attempt: number;
    status: DeliveryAttemptRecord['status'];
    errorCode?: string | undefined;
    errorMessage?: string | undefined;
    startedAt: Date;
    finishedAt: Date;
  }): DeliveryAttemptRecord;
  listByOutbox(outboxId: string): DeliveryAttemptRecord[];
  count(): number;
}

export interface DeadLetterRepo {
  list(query: PageQuery & { platform?: Platform | undefined }): Paged<DeadLetterRecord>;
  get(id: string): DeadLetterRecord | null;
  delete(id: string): boolean;
  count(): number;
}

// ---------------------------------------------------------------------------
// rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitBucketInput {
  scope: RateLimitScope;
  scopeId: string;
}

export interface RateLimitRepo {
  consume(
    bucket: RateLimitBucketInput,
    limit: { maxMessages: number; windowSeconds: number },
    now?: Date,
  ): RateLimitDecision;
  prune(olderThanSeconds?: number, now?: Date): number;
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

export interface RuleRepo {
  list(): MessageRule[];
  listEnabled(): MessageRule[];
  get(id: string): MessageRule | null;
  create(rule: MessageRule): MessageRule;
  update(id: string, patch: Partial<Omit<MessageRule, 'id' | 'createdAt'>>): MessageRule | null;
  remove(id: string): boolean;
  /** Applies the given order (highest priority first). */
  reorder(orderedIds: string[]): MessageRule[];
  counts(): { total: number; enabled: number };
  /** Next priority value to use for a new rule. */
  nextPriority(): number;
}

// ---------------------------------------------------------------------------
// settings (JSON key/value)
// ---------------------------------------------------------------------------

export interface SettingsRepo {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
  all(): Record<string, unknown>;
  delete(key: string): boolean;
}

// ---------------------------------------------------------------------------
// message timeline (console read model)
// ---------------------------------------------------------------------------

export interface MessageRecordInput {
  bridgeMessageId: string;
  platform: Platform;
  conversationKind: ConversationKind;
  conversationNativeId: string;
  conversationDisplayName?: string | null | undefined;
  senderNativeId: string;
  senderDisplayName?: string | null | undefined;
  onebotUserId?: number | null | undefined;
  onebotGroupId?: number | null | undefined;
  segments: UnifiedSegment[];
  text: string;
  status: MessageStatus | DeliveryStatus;
  reason?: string | null | undefined;
  matchedRuleId?: string | null | undefined;
  nativeMessageId?: string | null | undefined;
  createdAt?: Date | undefined;
}

export interface MessageRecordRow {
  id: string;
  bridgeMessageId: string;
  platform: Platform;
  conversationKind: ConversationKind;
  conversationNativeId: string;
  conversationDisplayName: string | null;
  senderNativeId: string;
  senderDisplayName: string | null;
  onebotUserId: number | null;
  onebotGroupId: number | null;
  segments: UnifiedSegment[];
  segmentTypes: string[];
  text: string;
  status: string;
  reason: string | null;
  matchedRuleId: string | null;
  nativeMessageId: string | null;
  createdAt: string;
}

export interface MessageListQuery extends PageQuery {
  platform?: Platform | undefined;
  conversationKind?: ConversationKind | undefined;
  conversationNativeId?: string | undefined;
  senderNativeId?: string | undefined;
  status?: string | undefined;
  search?: string | undefined;
}

export interface ConversationAggregateRow {
  platform: Platform;
  conversationKind: ConversationKind;
  conversationNativeId: string;
  displayName: string | null;
  onebotGroupId: number | null;
  messageCount: number;
  lastMessageAt: string;
}

export interface MessageRepo {
  record(input: MessageRecordInput): MessageRecordRow;
  list(query: MessageListQuery): Paged<MessageRecordRow>;
  conversations(query: PageQuery & { platform?: Platform | undefined; search?: string | undefined }): Paged<ConversationAggregateRow>;
  countLast24h(now?: Date): number;
  countByPlatformLast24h(now?: Date): PlatformCount[];
  /** Hourly buckets for the last 24 hours, oldest first. */
  trendLast24h(now?: Date, bucketMinutes?: number): MessageTrendPoint[];
  prune(olderThanDays: number, now?: Date): number;
}

// ---------------------------------------------------------------------------
// structured logs
// ---------------------------------------------------------------------------

export interface LogEntryInput {
  level: string;
  msg: string;
  time?: Date | undefined;
  platform?: string | null | undefined;
  event?: string | null | undefined;
  context?: Record<string, unknown> | null | undefined;
}

export interface LogEntryRow {
  id: string;
  time: string;
  level: string;
  msg: string;
  platform: string | null;
  event: string | null;
  context: Record<string, unknown> | null;
}

export interface LogRepo {
  append(entry: LogEntryInput): void;
  list(query: PageQuery & { level?: string | undefined; platform?: string | undefined; search?: string | undefined }): Paged<LogEntryRow>;
  recentErrors(limit?: number): LogEntryRow[];
  /** Keeps only the newest `maxRows` entries. */
  prune(maxRows?: number): number;
}

// ---------------------------------------------------------------------------
// facade
// ---------------------------------------------------------------------------

export interface Storage {
  readonly ids: IdMappingRepo;
  readonly dedupe: DedupeRepo;
  readonly outbox: OutboxRepo;
  readonly attempts: DeliveryAttemptRepo;
  readonly deadLetters: DeadLetterRepo;
  readonly rateLimits: RateLimitRepo;
  readonly rules: RuleRepo;
  readonly settings: SettingsRepo;
  readonly messages: MessageRepo;
  readonly logs: LogRepo;
  /** Applies pending migrations; idempotent. */
  migrate(): void;
  /** Schema version currently applied. */
  schemaVersion(): number;
  /** Flushes WAL and closes the database. */
  close(): void;
  /** Escape hatch for diagnostics only. */
  stats(): { sizeBytes: number; schemaVersion: number };
}
