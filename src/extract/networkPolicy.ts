import net from 'node:net';

export interface NetworkPolicyDecision {
  allowed: boolean;
  normalizedUrl?: string;
  reason?: string;
}

/**
 * Synchronous preflight. Fetch adapters must also resolve DNS and validate every
 * returned address before connecting, then repeat validation after redirects.
 */
export function validatePublicHttpUrl(raw: string): NetworkPolicyDecision {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: 'unsupported_protocol' };
  }
  if (url.username || url.password) {
    return { allowed: false, reason: 'embedded_credentials' };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const ipLiteral = stripIpv6Brackets(host);
  if (!host) return { allowed: false, reason: 'missing_host' };
  if (isBlockedHostname(host)) return { allowed: false, reason: 'blocked_hostname' };
  if (net.isIP(ipLiteral) && !isPublicIpAddress(ipLiteral)) {
    return { allowed: false, reason: 'non_public_ip' };
  }

  url.hash = '';
  return { allowed: true, normalizedUrl: url.toString() };
}

export function validateResolvedAddresses(addresses: string[]): NetworkPolicyDecision {
  if (!addresses.length) return { allowed: false, reason: 'dns_no_addresses' };
  if (addresses.some(address => !isPublicIpAddress(stripIpv6Brackets(address)))) {
    return { allowed: false, reason: 'dns_resolved_non_public_ip' };
  }
  return { allowed: true };
}

export function safeExtractionHeaders(userAgent = 'TabAtlas/0.1 local evidence extractor'): Record<string, string> {
  return {
    accept: 'text/html,application/xhtml+xml,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.2',
    'accept-encoding': 'gzip, br',
    'user-agent': userAgent,
  };
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address);
  const version = net.isIP(normalized);
  if (version === 4) return isPublicIpv4(normalized);
  if (version === 6) return isPublicIpv6(normalized);
  return false;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function isBlockedHostname(host: string): boolean {
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.home.arpa');
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && octets[2] === 100) return false;
  if (a === 203 && b === 0 && octets[2] === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith('ff')) return false;
  if (normalized.startsWith('2001:db8')) return false;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIpv4(mapped[1]);
  return true;
}
