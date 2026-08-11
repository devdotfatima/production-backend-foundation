import { describe, expect, it } from 'vitest';
import {
  UNRESOLVED_CLIENT_IP,
  clientIpKey,
  matchesAnyCidr,
  parseCidr,
  parseClientIp,
} from '../dist/src/lib/client-ip.js';

function cidrs(...values: string[]) {
  return values.map((value) => {
    const parsed = parseCidr(value);
    if (!parsed) throw new Error(`fixture is not a valid CIDR: ${value}`);
    return parsed;
  });
}

describe('client IP bucketing', () => {
  it('keeps IPv4 addresses at full precision', () => {
    expect(clientIpKey('203.0.113.7')).toBe('ip4:203.0.113.7');
    expect(clientIpKey('203.0.113.8')).not.toBe(clientIpKey('203.0.113.7'));
  });

  it('collapses IPv6 to the /64 allocation', () => {
    // The vulnerability this closes: a single consumer or VPS allocation is a /64, so bucketing
    // per exact address hands an attacker 2^64 free buckets.
    const first = clientIpKey('2001:db8:1:2:3:4:5:6');
    const second = clientIpKey('2001:db8:1:2:ffff:ffff:ffff:ffff');
    expect(first).toBe('ip6:2001:db8:1:2');
    expect(second).toBe(first);
  });

  it('separates distinct IPv6 allocations', () => {
    expect(clientIpKey('2001:db8:1:2::1')).not.toBe(clientIpKey('2001:db8:1:3::1'));
  });

  it('expands elided groups consistently', () => {
    expect(clientIpKey('2001:db8::1')).toBe('ip6:2001:db8:0:0');
    expect(clientIpKey('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('ip6:2001:db8:0:0');
    expect(clientIpKey('::1')).toBe('ip6:0:0:0:0');
  });

  it('unwraps IPv4-mapped IPv6 so one client cannot occupy two buckets', () => {
    expect(clientIpKey('::ffff:203.0.113.7')).toBe('ip4:203.0.113.7');
    expect(clientIpKey('::ffff:cb00:7107')).toBe('ip4:203.0.113.7');
    expect(clientIpKey('[::ffff:203.0.113.7]')).toBe('ip4:203.0.113.7');
  });

  it('ignores a zone index', () => {
    expect(clientIpKey('fe80::1%eth0')).toBe('ip6:fe80:0:0:0');
  });

  it('parses an embedded dotted-quad tail', () => {
    expect(clientIpKey('2001:db8::1.2.3.4')).toBe('ip6:2001:db8:0:0');
  });

  it('returns a namespaced sentinel for anything unparseable', () => {
    for (const value of [undefined, null, '', '   ', 'unknown', 'not-an-ip', '999.1.1.1']) {
      expect(clientIpKey(value)).toBe(UNRESOLVED_CLIENT_IP);
    }
  });

  it('cannot be spoofed into colliding with a real bucket', () => {
    // Keys are namespaced, so a client claiming to be "ip4:1.2.3.4" lands in the sentinel.
    expect(clientIpKey('ip4:203.0.113.7')).toBe(UNRESOLVED_CLIENT_IP);
    expect(clientIpKey(UNRESOLVED_CLIENT_IP)).toBe(UNRESOLVED_CLIENT_IP);
  });
});

describe('client IP parsing', () => {
  it('reports the family after unwrapping', () => {
    expect(parseClientIp('203.0.113.7')).toEqual({ family: 4, bytes: [203, 0, 113, 7] });
    expect(parseClientIp('::ffff:203.0.113.7')).toEqual({ family: 4, bytes: [203, 0, 113, 7] });
    expect(parseClientIp('2001:db8::1')?.family).toBe(6);
  });

  it('rejects malformed addresses', () => {
    for (const value of ['1.2.3', '1.2.3.4.5', '2001:db8:::1', 'gggg::1', '']) {
      expect(parseClientIp(value)).toBeUndefined();
    }
  });
});

describe('CIDR allowlist matching', () => {
  it('matches inside an IPv4 network and not outside it', () => {
    const networks = cidrs('10.0.0.0/8');
    expect(matchesAnyCidr('10.1.2.3', networks)).toBe(true);
    expect(matchesAnyCidr('11.1.2.3', networks)).toBe(false);
  });

  it('honours a prefix that does not fall on a byte boundary', () => {
    const networks = cidrs('192.168.4.0/22');
    expect(matchesAnyCidr('192.168.4.1', networks)).toBe(true);
    expect(matchesAnyCidr('192.168.7.255', networks)).toBe(true);
    expect(matchesAnyCidr('192.168.8.1', networks)).toBe(false);
  });

  it('matches IPv6 networks', () => {
    const networks = cidrs('2001:db8::/32');
    expect(matchesAnyCidr('2001:db8:ffff::1', networks)).toBe(true);
    expect(matchesAnyCidr('2001:db9::1', networks)).toBe(false);
  });

  it('treats a bare address as a single host', () => {
    const networks = cidrs('203.0.113.7');
    expect(matchesAnyCidr('203.0.113.7', networks)).toBe(true);
    expect(matchesAnyCidr('203.0.113.8', networks)).toBe(false);
  });

  it('never matches across address families', () => {
    expect(matchesAnyCidr('2001:db8::1', cidrs('0.0.0.0/0'))).toBe(false);
    expect(matchesAnyCidr('10.0.0.1', cidrs('::/0'))).toBe(false);
  });

  it('does not match an empty allowlist or an unparseable address', () => {
    expect(matchesAnyCidr('10.0.0.1', [])).toBe(false);
    expect(matchesAnyCidr('not-an-ip', cidrs('0.0.0.0/0'))).toBe(false);
  });

  it('rejects malformed CIDR input', () => {
    for (const value of ['10.0.0.0/33', '2001:db8::/129', '10.0.0.0/x', '10.0.0.0/8/8', 'nope']) {
      expect(parseCidr(value)).toBeUndefined();
    }
  });
});
