import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for outbound HTTP from nodes.
 *
 * The guard runs *before* any connection is made: it validates the URL
 * scheme, blocks loopback / private / link-local targets (including the
 * cloud metadata address 169.254.169.254), and resolves hostnames to check
 * every resulting address. The engine accepts a guard via options so tests
 * and trusted deployments can substitute their own policy; the default
 * guard below denies private IPs.
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** A guard throws SsrfError to block a request before it is made. */
export type SsrfGuard = (url: URL) => Promise<void>;

export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0.0.0.0/8 "this host"
    if (a === 169 && b === 254) return true; // link-local / metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9')) return true; // fe80::/10
    if (lower.startsWith('fea') || lower.startsWith('feb')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('ff')) return true; // multicast
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

export interface SsrfGuardOptions {
  /** Allow private/loopback targets (local development only). */
  allowPrivate?: boolean;
  /** Hostnames that are always allowed (skips DNS checks). */
  allowedHosts?: string[];
  /** Injectable DNS resolver (tests). Returns IP strings for a hostname. */
  lookup?: (hostname: string) => Promise<string[]>;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

export function createSsrfGuard(options: SsrfGuardOptions = {}): SsrfGuard {
  const allowedHosts = new Set(
    (options.allowedHosts ?? []).map((h) => h.toLowerCase()),
  );
  const resolve = options.lookup ?? defaultLookup;

  return async (url: URL): Promise<void> => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SsrfError(
        `Blocked URL scheme "${url.protocol}" — only http: and https: are allowed`,
      );
    }
    const host = url.hostname.toLowerCase();
    if (allowedHosts.has(host)) return;

    if (isIP(host)) {
      if (!options.allowPrivate && isPrivateIp(host)) {
        throw new SsrfError(`Blocked request to private IP ${host}`);
      }
      return;
    }

    if (host === 'localhost' || host.endsWith('.local')) {
      if (!options.allowPrivate) {
        throw new SsrfError(`Blocked request to local hostname ${host}`);
      }
      return;
    }

    if (options.allowPrivate) return;

    let addresses: string[];
    try {
      addresses = await resolve(host);
    } catch (err) {
      throw new SsrfError(
        `Blocked request to ${host}: DNS lookup failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    for (const address of addresses) {
      if (isPrivateIp(address)) {
        throw new SsrfError(
          `Blocked request to ${host}: resolves to private IP ${address}`,
        );
      }
    }
  };
}

/** Default policy: deny private IPs, loopback, link-local and bad schemes. */
export const defaultSsrfGuard: SsrfGuard = createSsrfGuard();

/** Permissive guard for tests / fully trusted environments. */
export const allowAllSsrfGuard: SsrfGuard = async () => {};
