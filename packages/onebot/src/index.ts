/**
 * OneBot 11 reverse WebSocket server.
 *
 * Public surface: server factory, action registry, access token verification
 * and `BridgeError` to OneBot response mapping.
 */
export * from './contracts.js';
export { verifyAccessToken } from './auth.js';
export { createActionRegistry } from './registry.js';
export { createOneBotServer } from './server.js';
export { sanitizeErrorMessage, toOneBotErrorResponse } from './errors.js';
