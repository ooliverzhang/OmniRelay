import { BridgeError, isBridgeError, ONEBOT_RETCODE } from '@omni-relay/shared-types';
import type {
  OneBotActionRequest,
  OneBotActionResponse,
  OneBotStatus,
} from '@omni-relay/shared-types';

import type {
  ActionContext,
  ActionHandler,
  ActionHandlerResult,
  ActionRegistry,
  OneBotLogger,
} from './contracts.js';
import { toOneBotErrorResponse } from './errors.js';

/** Params that are not a plain object are treated as an empty object. */
function normalizeParams(params: unknown): Record<string, unknown> {
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return {};
}

function normalizeResult(result: ActionHandlerResult | null | undefined): ActionHandlerResult {
  return result ?? {};
}

function buildResponse(
  status: OneBotStatus,
  retcode: number,
  echo: string | number | undefined,
  data: unknown,
  message: string | undefined,
): OneBotActionResponse {
  const response: OneBotActionResponse = { status, retcode };
  if (data !== undefined) {
    response.data = data;
  }
  if (message !== undefined) {
    response.message = message;
  }
  if (echo !== undefined) {
    response.echo = echo;
  }
  return response;
}

/**
 * Creates a registry that dispatches OneBot actions to application handlers.
 *
 * `handle` never throws: every failure is converted into a `failed` response so
 * the WebSocket loop always has something to send back.
 */
export function createActionRegistry(logger?: OneBotLogger): ActionRegistry {
  const handlers = new Map<string, ActionHandler>();

  return {
    register(action: string, handler: ActionHandler): void {
      if (handlers.has(action)) {
        throw new Error(`action_already_registered:${action}`);
      }
      handlers.set(action, handler);
      logger?.debug('onebot action registered', { action, total: handlers.size });
    },

    has(action: string): boolean {
      return handlers.has(action);
    },

    list(): string[] {
      return [...handlers.keys()];
    },

    async handle(
      request: OneBotActionRequest,
      context: ActionContext,
    ): Promise<OneBotActionResponse> {
      const handler = handlers.get(request.action);
      if (handler === undefined) {
        logger?.debug('onebot unknown action', { action: request.action });
        return toOneBotErrorResponse(
          new BridgeError({ code: 'not_found', message: `unknown_action:${request.action}` }),
          request.echo,
        );
      }

      const params = normalizeParams(request.params);
      try {
        const result = normalizeResult(await handler(params, context));
        if (result.status === 'async') {
          return buildResponse(
            'async',
            ONEBOT_RETCODE.ASYNC,
            request.echo,
            result.data,
            result.message,
          );
        }
        return buildResponse('ok', ONEBOT_RETCODE.OK, request.echo, result.data, result.message);
      } catch (error) {
        logger?.warn('onebot action failed', {
          action: request.action,
          code: isBridgeError(error) ? error.code : 'internal',
        });
        return toOneBotErrorResponse(error, request.echo);
      }
    },
  };
}
