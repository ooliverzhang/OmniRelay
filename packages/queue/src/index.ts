export * from './contracts.js';
export { computeBackoff } from './backoff.js';
export { classifyDeliveryError, redactText } from './classify.js';
export { createOutboxWorker } from './worker.js';
export { createDeliveryPlanner } from './planner.js';

/** Package identifier, kept for diagnostics. */
export const packageName = '@omni-relay/queue' as const;
