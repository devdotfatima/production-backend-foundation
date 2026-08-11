import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_TYPE_HEADER,
  getBearerToken,
  isMobileClient,
  resolveAccessToken,
  resolveRefreshToken,
  usesCookieAuth,
} from '../dist/src/lib/auth-transport.js';

function fakeRequest(options: {
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  body?: unknown;
}): Request {
  const headers = options.headers ?? {};
  return {
    header: (name: string) => headers[name.toLowerCase()],
    cookies: options.cookies,
    body: options.body,
  } as unknown as Request;
}

describe('isMobileClient', () => {
  it('is true when the client-type header is "mobile", case-insensitively', () => {
    expect(isMobileClient(fakeRequest({ headers: { [CLIENT_TYPE_HEADER]: 'Mobile' } }))).toBe(true);
  });

  it('is false when the header is absent or set to a different value', () => {
    expect(isMobileClient(fakeRequest({}))).toBe(false);
    expect(isMobileClient(fakeRequest({ headers: { [CLIENT_TYPE_HEADER]: 'web' } }))).toBe(false);
  });
});

describe('getBearerToken', () => {
  it('extracts the token from a Bearer authorization header', () => {
    expect(getBearerToken(fakeRequest({ headers: { authorization: 'Bearer abc.def.ghi' } }))).toBe(
      'abc.def.ghi',
    );
  });

  it('returns undefined for missing, non-Bearer, or empty tokens', () => {
    expect(getBearerToken(fakeRequest({}))).toBeUndefined();
    expect(
      getBearerToken(fakeRequest({ headers: { authorization: 'Basic xyz' } })),
    ).toBeUndefined();
    expect(getBearerToken(fakeRequest({ headers: { authorization: 'Bearer ' } }))).toBeUndefined();
  });
});

describe('resolveAccessToken', () => {
  it('prefers a bearer token over the access cookie', () => {
    const request = fakeRequest({
      headers: { authorization: 'Bearer bearer-token' },
      cookies: { access_token: 'cookie-token' },
    });
    expect(resolveAccessToken(request)).toBe('bearer-token');
  });

  it('falls back to the access cookie when there is no bearer header', () => {
    expect(resolveAccessToken(fakeRequest({ cookies: { access_token: 'cookie-token' } }))).toBe(
      'cookie-token',
    );
  });

  it('returns undefined when neither transport carries a token', () => {
    expect(resolveAccessToken(fakeRequest({}))).toBeUndefined();
  });
});

describe('resolveRefreshToken', () => {
  it('reads the refresh token from the JSON body for mobile clients', () => {
    const request = fakeRequest({
      headers: { [CLIENT_TYPE_HEADER]: 'mobile' },
      cookies: { refresh_token: 'cookie-refresh' },
      body: { refreshToken: 'body-refresh' },
    });
    expect(resolveRefreshToken(request)).toBe('body-refresh');
  });

  it('ignores the refresh cookie for mobile clients even without a body token', () => {
    const request = fakeRequest({
      headers: { [CLIENT_TYPE_HEADER]: 'mobile' },
      cookies: { refresh_token: 'cookie-refresh' },
    });
    expect(resolveRefreshToken(request)).toBeUndefined();
  });

  it('reads the refresh token from the cookie for web clients', () => {
    expect(resolveRefreshToken(fakeRequest({ cookies: { refresh_token: 'cookie-refresh' } }))).toBe(
      'cookie-refresh',
    );
  });
});

describe('usesCookieAuth', () => {
  it('is true for a plain request with no bearer header or mobile flag', () => {
    expect(usesCookieAuth(fakeRequest({}))).toBe(true);
  });

  it('is false when a bearer token is present', () => {
    expect(usesCookieAuth(fakeRequest({ headers: { authorization: 'Bearer token' } }))).toBe(false);
  });

  it('is false when the mobile client-type header is present', () => {
    expect(usesCookieAuth(fakeRequest({ headers: { [CLIENT_TYPE_HEADER]: 'mobile' } }))).toBe(
      false,
    );
  });
});
