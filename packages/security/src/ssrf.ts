/**
 * DNS-pinning SSRF firewall (spec §8D).
 *
 * Every outbound URL (HTTP nodes, connector calls, webhooks) must pass
 * assertUrlAllowed BEFORE any request is made. It blocks:
 *  - non-http(s) schemes
 *  - localhost and internal Docker service hostnames (postgres, redis, ...)
 *  - loopback, private LAN, link-local (incl. the cloud metadata address
 *    169.254.169.254), 0.0.0.0/8, multicast and reserved IPv4 ranges
 *  - IPv6 loopback/unspecified/link-local/ULA/multicast, and IPv4-mapped
 *    IPv6 addresses whose embedded IPv4 is blocked
 *  - hostnames that RESOLVE (via dns.lookup) to any blocked IP — the caller
 *    gets back the validated addresses so the request can be pinned to the
 *    checked IP, defeating DNS-rebinding between check and connect.
 *
 * An owner may explicitly allowlist a hostname, IP or CIDR (e.g. an
 * intentional local store IP) via the `allowlist` option.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrfError extends Error {
  readonly code = 'SSRF_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface SsrfOptions {
  /**
   * Hostnames, IPs or CIDRs that are explicitly allowed even if they would
   * otherwise be blocked (owner whitelist for intentional local targets).
   */
  allowlist?: string[];
  /** Injectable DNS resolver for testing; defaults to dns.lookup(all). */
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export interface ValidatedUrl {
  /** The parsed, validated URL. */
  url: URL;
  /** The hostname from the URL. */
  hostname: string;
  /** All validated resolved IPs (or the IP literal itself). Pin requests to these. */
  resolvedIps: string[];
  /** The first resolved IP — the primary pin target. */
  resolvedIp: string;
}

/** Hostnames that always name internal infrastructure (spec §8D). */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'postgres',
  'redis',
  'ollama',
  'ai-media-worker',
  'api',
  'worker',
  'web',
  'db',
  'database',
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

function ipv4InCidr(ipInt: number, base: string, prefix: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** Blocked IPv4 ranges: [base, prefix]. */
const BLOCKED_IPV4_CIDRS: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this host on this network" (incl. 0.0.0.0)
  ['10.0.0.0', 8], // private LAN
  ['100.64.0.0', 10], // CGNAT shared address space
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private LAN
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1 (documentation)
  ['192.168.0.0', 16], // private LAN
  ['198.51.100.0', 24], // TEST-NET-2 (documentation)
  ['203.0.113.0', 24], // TEST-NET-3 (documentation)
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved (incl. 255.255.255.255)
];

/** True if an IPv4 address falls in any blocked range. */
export function isBlockedIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return true; // unparsable → fail closed
  return BLOCKED_IPV4_CIDRS.some(([base, prefix]) => ipv4InCidr(ipInt, base, prefix));
}

/** Expand an IPv6 address to its 8 16-bit groups, or null if invalid. */
function ipv6Groups(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  // IPv4-mapped / embedded IPv4 tail: convert dotted tail to two hex groups.
  const lastColon = addr.lastIndexOf(':');
  const tail = lastColon >= 0 ? addr.slice(lastColon + 1) : '';
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const parsed = groups.map((g) => (/^[0-9a-f]{1,4}$/u.test(g) ? parseInt(g, 16) : Number.NaN));
  return parsed.some((n) => Number.isNaN(n)) ? null : parsed;
}

/** True if an IPv6 address is loopback/unspecified/link-local/ULA/multicast/site-local or embeds a blocked IPv4. */
export function isBlockedIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (g === null) return true; // unparsable → fail closed
  // :: (unspecified) and ::1 (loopback)
  if (g.every((n) => n === 0)) return true;
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true;
  // IPv4-mapped ::ffff:a.b.c.d → judge the embedded IPv4
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    const embedded = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
    return isBlockedIpv4(embedded);
  }
  const first = g[0];
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  return false;
}

/** True if an IP literal (v4 or v6) is blocked by the SSRF policy. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP literal → fail closed
}

function matchesAllowlist(
  hostname: string,
  ips: string[],
  allowlist: string[],
): boolean {
  const host = hostname.toLowerCase();
  for (const entryRaw of allowlist) {
    const entry = entryRaw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === host) return true;
    if (entry.includes('/')) {
      // CIDR entry — applies to IPv4 resolved IPs.
      const [base, prefixStr] = entry.split('/');
      const prefix = Number(prefixStr);
      if (isIP(base) === 4 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
        if (ips.some((ip) => isIP(ip) === 4 && ipv4InCidr(ipv4ToInt(ip) ?? -1, base, prefix))) {
          return true;
        }
      }
      continue;
    }
    if (ips.includes(entry)) return true;
  }
  return false;
}

async function defaultResolve(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  return lookup(hostname, { all: true, verbatim: true });
}

/**
 * Validate an outbound URL against the SSRF policy.
 *
 * Resolves to { url, hostname, resolvedIp, resolvedIps } — the caller should
 * pin its HTTP request to `resolvedIp` (with the original Host/SNI) so the
 * address that was checked is the address that is connected to.
 * Throws SsrfError on any policy violation.
 */
export async function assertUrlAllowed(
  rawUrl: string | URL,
  options: SsrfOptions = {},
): Promise<ValidatedUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl.toString());
  } catch {
    throw new SsrfError(`Invalid URL: ${JSON.stringify(String(rawUrl))}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`Blocked URL scheme ${JSON.stringify(url.protocol)} — only http: and https: are allowed`);
  }
  if (url.username || url.password) {
    throw new SsrfError('URLs with embedded credentials are not allowed');
  }

  // Note: URL.hostname keeps the brackets on IPv6 literals and normalizes
  // IPv4-mapped forms (e.g. [::ffff:127.0.0.1] → [::ffff:7f00:1]); strip the
  // brackets and let isBlockedIpv6 judge the (possibly embedded) address.
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[/u, '')
    .replace(/\]$/u, '')
    .replace(/\.$/u, '');
  if (!hostname) {
    throw new SsrfError('URL has no hostname');
  }

  const allowlist = options.allowlist ?? [];
  const literalFamily = isIP(hostname);

  // IP literal: no DNS involved, judge it directly.
  if (literalFamily !== 0) {
    if (isBlockedIp(hostname) && !matchesAllowlist(hostname, [hostname], allowlist)) {
      throw new SsrfError(`Blocked IP address ${hostname} (loopback/private/link-local/reserved range)`);
    }
    return { url, hostname, resolvedIps: [hostname], resolvedIp: hostname };
  }

  // Hostname policy: localhost & internal service names.
  const isLocalhostName = hostname === 'localhost' || hostname.endsWith('.localhost');
  if ((isLocalhostName || BLOCKED_HOSTNAMES.has(hostname)) && !matchesAllowlist(hostname, [], allowlist)) {
    throw new SsrfError(`Blocked hostname ${JSON.stringify(hostname)} (internal/localhost name)`);
  }

  // DNS-pinning check: resolve and judge EVERY returned address.
  const resolve = options.resolve ?? defaultResolve;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolve(hostname);
  } catch (err) {
    throw new SsrfError(`DNS resolution failed for ${JSON.stringify(hostname)}: ${(err as Error).message}`);
  }
  if (!addresses || addresses.length === 0) {
    throw new SsrfError(`DNS resolution returned no addresses for ${JSON.stringify(hostname)}`);
  }
  const ips = addresses.map((a) => a.address);
  const blocked = ips.filter((ip) => isBlockedIp(ip));
  if (blocked.length > 0 && !matchesAllowlist(hostname, ips, allowlist)) {
    throw new SsrfError(
      `Hostname ${JSON.stringify(hostname)} resolves to blocked IP(s): ${blocked.join(', ')}`,
    );
  }
  return { url, hostname, resolvedIps: ips, resolvedIp: ips[0] };
}
