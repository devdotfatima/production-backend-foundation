import { describe, expect, it } from 'vitest';
import { uuidV7 } from '../dist/src/lib/id.js';

describe('UUIDv7 identifiers', () => {
  it('emits RFC 9562 version and variant bits with timestamp ordering', () => {
    const earlier = uuidV7(Date.UTC(2026, 0, 1));
    const later = uuidV7(Date.UTC(2026, 0, 2));

    expect(earlier).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(later > earlier).toBe(true);
  });
});
