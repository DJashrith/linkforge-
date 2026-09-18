import { BlockList, isIP } from 'node:net';

export const MAX_URL_LENGTH = 2048;
export const ALIAS_MIN_LENGTH = 3;
export const ALIAS_MAX_LENGTH = 16; // matches urls.short_code VARCHAR(16)

// Anything that could be a short code: base62 output plus the extra alias characters.
export const SHORT_CODE_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
const ALIAS_PATTERN = /^[A-Za-z0-9_-]+$/;

// Paths that are (or will be) real routes, so they can't be claimed as aliases.
const RESERVED_ALIASES = new Set([
  'shorten', 'health', 'api', 'admin', 'login', 'logout', 'signup', 'register',
  'dashboard', 'settings', 'static', 'assets', 'docs', 'urls', 'stats',
]);

const PRIVATE_NETWORKS = new BlockList();
PRIVATE_NETWORKS.addSubnet('0.0.0.0', 8);
PRIVATE_NETWORKS.addSubnet('10.0.0.0', 8);
PRIVATE_NETWORKS.addSubnet('100.64.0.0', 10); // carrier-grade NAT
PRIVATE_NETWORKS.addSubnet('127.0.0.0', 8);
PRIVATE_NETWORKS.addSubnet('169.254.0.0', 16); // link-local, incl. cloud metadata
PRIVATE_NETWORKS.addSubnet('172.16.0.0', 12);
PRIVATE_NETWORKS.addSubnet('192.168.0.0', 16);
PRIVATE_NETWORKS.addSubnet('::', 127, 'ipv6'); // :: and ::1
// No rule needed for IPv4-mapped IPv6 (::ffff:127.0.0.1): BlockList checks those
// against the IPv4 rules above. A ::ffff:0:0/96 rule would block every IPv4 address.
PRIVATE_NETWORKS.addSubnet('fc00::', 7, 'ipv6'); // unique local
PRIVATE_NETWORKS.addSubnet('fe80::', 10, 'ipv6'); // link-local

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/**
 * Checks that input is a public http(s) URL we're willing to redirect to.
 * @returns {{ url: string } | { error: string }} url is the normalized href
 */
export function validateLongUrl(input, { ownHost = null, blockedDomains = [] } = {}) {
  if (typeof input !== 'string' || input.trim() === '') return { error: 'url is required' };
  if (input.length > MAX_URL_LENGTH) return tooLong();

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return { error: 'url is not a valid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'only http and https URLs are allowed' };
  }
  // https://paypal.com@evil.example actually goes to evil.example
  if (url.username || url.password) {
    return { error: 'URLs with a username or password in them are not allowed' };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isLocalHost(host)) {
    return { error: 'URLs pointing to localhost or private networks are not allowed' };
  }
  if (!isIP(host) && !host.includes('.')) {
    return { error: 'url must point to a public domain' };
  }
  if (ownHost && url.host === ownHost) {
    return { error: 'that URL is already a short link' };
  }
  if (blockedDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { error: 'links to that domain are not allowed' };
  }

  // Normalizing can grow the string (percent-encoding), so check again.
  if (url.href.length > MAX_URL_LENGTH) return tooLong();
  return { url: url.href };
}

/**
 * @returns {{ alias: string } | { error: string }}
 */
export function validateAlias(input) {
  if (typeof input !== 'string') return { error: 'alias must be a string' };
  if (input.length < ALIAS_MIN_LENGTH || input.length > ALIAS_MAX_LENGTH) {
    return { error: `alias must be ${ALIAS_MIN_LENGTH}-${ALIAS_MAX_LENGTH} characters` };
  }
  if (!ALIAS_PATTERN.test(input)) {
    return { error: 'alias can only contain letters, numbers, - and _' };
  }
  if (RESERVED_ALIASES.has(input.toLowerCase())) {
    return { error: `"${input}" is reserved, pick another alias` };
  }
  return { alias: input };
}

/**
 * expires_at from a request body: an ISO 8601 timestamp, or null for "never".
 * Past dates are allowed on purpose, that's how you expire a link right now.
 * @returns {{ expiresAt: Date | null } | { error: string }}
 */
export function validateExpiresAt(input) {
  if (input === null) return { expiresAt: null };
  // Date.parse accepts things like "3", so require at least YYYY-MM-DD
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(input) || Number.isNaN(Date.parse(input))) {
    return { error: 'expires_at must be an ISO 8601 date like 2026-12-31T23:59:59Z, or null' };
  }
  return { expiresAt: new Date(input) };
}

function isLocalHost(host) {
  const type = isIP(host);
  if (type === 4) return PRIVATE_NETWORKS.check(host, 'ipv4');
  if (type === 6) return PRIVATE_NETWORKS.check(host, 'ipv6');
  return host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s));
}

function tooLong() {
  return { error: `url is too long (max ${MAX_URL_LENGTH} characters)` };
}
