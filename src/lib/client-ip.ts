import { isIPv4, isIPv6 } from 'node:net';

/**
 * Distinct from any real address key so an unresolvable client can never be confused with — or
 * spoofed into — a genuine bucket.
 */
export const UNRESOLVED_CLIENT_IP = 'ip:unresolved';

/** Bits of an IPv6 address that identify the allocation rather than the host. */
const IPV6_BUCKET_BITS = 64;

export interface ParsedIp {
  family: 4 | 6;
  bytes: number[];
}

function parseIpv4Bytes(value: string): number[] | undefined {
  if (!isIPv4(value)) return undefined;
  return value.split('.').map(Number);
}

function parseIpv6Bytes(input: string): number[] | undefined {
  // Drop any zone index (fe80::1%eth0); it identifies a local interface, not a peer.
  const zoneIndex = input.indexOf('%');
  let value = zoneIndex === -1 ? input : input.slice(0, zoneIndex);

  // Rewrite a trailing dotted-quad (2001:db8::1.2.3.4) into two hextets.
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    const embedded = parseIpv4Bytes(tail);
    if (!embedded) return undefined;
    const high = ((embedded[0]! << 8) | embedded[1]!).toString(16);
    const low = ((embedded[2]! << 8) | embedded[3]!).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = value.split('::');
  let groups: string[];
  if (halves.length === 1) {
    groups = value.split(':');
  } else if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const elided = 8 - left.length - right.length;
    if (elided < 1) return undefined;
    groups = [...left, ...new Array<string>(elided).fill('0'), ...right];
  } else {
    return undefined;
  }
  if (groups.length !== 8) return undefined;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    const word = Number.parseInt(group, 16);
    bytes.push((word >> 8) & 0xff, word & 0xff);
  }
  return bytes;
}

function isIpv4Mapped(bytes: number[]): boolean {
  for (let index = 0; index < 10; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/** Parses an address into raw bytes, unwrapping IPv4-mapped IPv6 (`::ffff:1.2.3.4`). */
export function parseClientIp(value: string | undefined | null): ParsedIp | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/^\[|\]$/g, '');
  if (!trimmed) return undefined;

  const ipv4 = parseIpv4Bytes(trimmed);
  if (ipv4) return { family: 4, bytes: ipv4 };

  const zoneless = trimmed.split('%')[0]!;
  if (!isIPv6(zoneless)) return undefined;
  const ipv6 = parseIpv6Bytes(trimmed);
  if (!ipv6) return undefined;
  if (isIpv4Mapped(ipv6)) return { family: 4, bytes: ipv6.slice(12) };
  return { family: 6, bytes: ipv6 };
}

function hextets(bytes: number[], count: number): string {
  const groups: string[] = [];
  for (let index = 0; index < count; index += 2) {
    groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
  }
  return groups.join(':');
}

/**
 * Canonical rate-limit bucket for a client address.
 *
 * IPv6 collapses to its /64 because a single consumer or VPS allocation *is* a /64: bucketing
 * per exact address hands an attacker 2^64 free buckets. IPv4 keeps its full /32.
 */
export function clientIpKey(value: string | undefined | null): string {
  const parsed = parseClientIp(value);
  if (!parsed) return UNRESOLVED_CLIENT_IP;
  if (parsed.family === 4) return `ip4:${parsed.bytes.join('.')}`;
  return `ip6:${hextets(parsed.bytes, IPV6_BUCKET_BITS / 8)}`;
}

export interface ParsedCidr extends ParsedIp {
  prefix: number;
}

/** Parses `10.0.0.0/8`, `2001:db8::/32`, or a bare address (treated as a single host). */
export function parseCidr(input: string): ParsedCidr | undefined {
  const [address, prefixText, ...rest] = input.trim().split('/');
  if (rest.length > 0 || !address) return undefined;

  const parsed = parseClientIp(address);
  if (!parsed) return undefined;

  const maxPrefix = parsed.bytes.length * 8;
  if (prefixText === undefined) return { ...parsed, prefix: maxPrefix };
  if (!/^\d{1,3}$/.test(prefixText)) return undefined;

  const prefix = Number(prefixText);
  if (prefix > maxPrefix) return undefined;
  return { ...parsed, prefix };
}

function withinPrefix(candidate: number[], network: number[], prefix: number): boolean {
  const wholeBytes = prefix >> 3;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (candidate[index] !== network[index]) return false;
  }
  const remainingBits = prefix & 7;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((candidate[wholeBytes] ?? 0) & mask) === ((network[wholeBytes] ?? 0) & mask);
}

/** True when the address falls inside any of the supplied networks. */
export function matchesAnyCidr(value: string | undefined | null, networks: ParsedCidr[]): boolean {
  if (networks.length === 0) return false;
  const parsed = parseClientIp(value);
  if (!parsed) return false;
  return networks.some(
    (network) =>
      network.family === parsed.family && withinPrefix(parsed.bytes, network.bytes, network.prefix),
  );
}

export interface TrustedProxyInput {
  remoteAddress: string | undefined | null;
  forwardedFor: string | string[] | undefined;
  trustedHops: number;
  trustedCidrs: ParsedCidr[];
}

/**
 * Resolves the same right-to-left proxy chain used by Express. Forwarded values are considered
 * only while the immediately downstream hop is trusted, so a public client cannot spoof the
 * socket rate-limit address by adding X-Forwarded-For itself.
 */
export function trustedClientAddress(input: TrustedProxyInput): string | undefined {
  const remote = input.remoteAddress?.trim();
  if (!remote || !parseClientIp(remote)) return undefined;
  const raw = Array.isArray(input.forwardedFor) ? input.forwardedFor.join(',') : input.forwardedFor;
  const forwarded = raw
    ? raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .reverse()
    : [];
  if (forwarded.some((value) => !parseClientIp(value))) return remote;

  if (input.trustedHops > 0) {
    const chain = [remote, ...forwarded];
    return chain[Math.min(input.trustedHops, chain.length - 1)];
  }
  if (input.trustedCidrs.length === 0) return remote;

  let address = remote;
  for (const candidate of forwarded) {
    if (!matchesAnyCidr(address, input.trustedCidrs)) break;
    address = candidate;
  }
  return address;
}
