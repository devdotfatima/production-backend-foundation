import { describe, expect, it } from 'vitest';
import { assertResourceOwner } from '../dist/src/lib/resource-ownership.js';

describe('resource ownership', () => {
  it('allows the authenticated owner', () => {
    expect(() => assertResourceOwner('user-1', 'user-1')).not.toThrow();
  });

  it('rejects a different authenticated user', () => {
    expect(() => assertResourceOwner('user-1', 'user-2')).toThrowError(
      expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' }),
    );
  });
});
