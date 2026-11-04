import { describe, expect, it } from 'vitest';

import { BridgeError } from '@omni-relay/shared-types';
import type { ErrorCode } from '@omni-relay/shared-types';
import { sanitizeErrorMessage, toOneBotErrorResponse } from '@omni-relay/onebot';

const TOKEN = 'test-token';

const RETCODE_CASES: ReadonlyArray<readonly [ErrorCode, number]> = [
  ['unauthorized', 1403],
  ['forbidden', 1403],
  ['not_found', 1404],
  ['capability_unsupported', 1405],
  ['rate_limited', 1429],
  ['timeout', 1504],
  ['invalid_config', 1400],
  ['message_too_large', 1400],
  ['platform_rejected', 100],
  ['quota_exceeded', 100],
  ['attachment_unavailable', 100],
  ['platform_unavailable', 1500],
  ['internal', 1500],
];

describe('toOneBotErrorResponse', () => {
  it.each(RETCODE_CASES)('maps the %s bridge code to retcode %i', (code, retcode) => {
    const response = toOneBotErrorResponse(new BridgeError({ code, message: 'boom' }), 'echo-1');
    expect(response).toEqual({
      status: 'failed',
      retcode,
      message: 'boom',
      echo: 'echo-1',
    });
  });

  it('maps unknown failures to a fixed internal error without leaking details', () => {
    const response = toOneBotErrorResponse(new Error(`secret failure near ${TOKEN}`));
    expect(response).toEqual({ status: 'failed', retcode: 1500, message: 'internal_error' });
    expect(response.echo).toBeUndefined();
  });

  it('omits echo when the request had none', () => {
    const response = toOneBotErrorResponse(new BridgeError({ code: 'not_found', message: 'nope' }));
    expect(response.echo).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain('echo');
  });

  it('supports numeric echo values', () => {
    const response = toOneBotErrorResponse(
      new BridgeError({ code: 'internal', message: 'boom' }),
      42,
    );
    expect(response.echo).toBe(42);
  });

  it('redacts bearer tokens from bridge error messages', () => {
    const response = toOneBotErrorResponse(
      new BridgeError({ code: 'forbidden', message: `denied for Bearer ${TOKEN}` }),
    );
    expect(response.message).not.toContain(TOKEN);
    expect(response.message).toContain('[redacted]');
  });

  it('redacts token, access_token and secret parameters', () => {
    const message = `token=${TOKEN} access_token=${TOKEN} secret=${TOKEN}`;
    const response = toOneBotErrorResponse(new BridgeError({ code: 'internal', message }));
    expect(response.message).not.toContain(TOKEN);
    expect(response.message).toBe('[redacted] [redacted] [redacted]');
  });

  it('truncates long messages to 512 characters', () => {
    const response = toOneBotErrorResponse(
      new BridgeError({ code: 'internal', message: 'x'.repeat(1000) }),
    );
    expect(response.message).toHaveLength(512);
  });

  it('sanitises before truncating so a secret cannot survive the cut', () => {
    const sanitized = sanitizeErrorMessage(`a${'b'.repeat(600)} Bearer ${TOKEN}`);
    expect(sanitized).toHaveLength(512);
    expect(sanitized).not.toContain(TOKEN);
  });
});
