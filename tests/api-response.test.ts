import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { sendError, sendSuccess } from '../src/lib/api-response.js';

function responseDouble() {
  const json = vi.fn();
  const response = { status: vi.fn(), json };
  response.status.mockReturnValue(response);
  return { response: response as unknown as Response, json };
}

const request = { id: 'request-123' } as Request;

describe('API response envelope', () => {
  it('uses the universal success shape', () => {
    const { response, json } = responseDouble();
    sendSuccess(request, response, { message: 'Done', data: { id: 1 } });
    expect(json).toHaveBeenCalledWith({
      success: true,
      message: 'Done',
      data: { id: 1 },
      error: null,
      meta: { requestId: 'request-123' },
    });
  });

  it('uses the universal error shape', () => {
    const { response, json } = responseDouble();
    sendError(request, response, { status: 400, code: 'BAD_REQUEST', message: 'Invalid' });
    expect(json).toHaveBeenCalledWith({
      success: false,
      message: 'Invalid',
      data: null,
      error: { code: 'BAD_REQUEST', details: null },
      meta: { requestId: 'request-123' },
    });
  });
});
