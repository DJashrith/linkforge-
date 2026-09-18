// Turns a raw stream entry into a row for click_events. Anything malformed is
// rejected here, so one bad entry can't make the whole batch INSERT fail forever.
import geoip from 'geoip-lite';
import { SHORT_CODE_PATTERN } from '../validation.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string[] | null} fields flat [key, value, key, value, ...] as Redis returns them
 *   (null if the entry was trimmed from the stream while it was still pending)
 * @returns {object | null} null if the entry is unusable
 */
export function toClickRow(fields) {
  if (!Array.isArray(fields)) return null;
  const e = {};
  for (let i = 0; i + 1 < fields.length; i += 2) e[fields[i]] = fields[i + 1];

  const ts = Number(e.ts);
  if (!UUID_PATTERN.test(e.id ?? '') || !SHORT_CODE_PATTERN.test(e.code ?? '') || !Number.isFinite(ts)) {
    return null;
  }

  const geo = lookupGeo(e.ip);
  return {
    event_id: e.id,
    code: e.code,
    clicked_at: new Date(ts).toISOString(),
    referrer: e.ref || null,
    user_agent: e.ua || null,
    country: geo?.country || null,
    region: geo?.region || null,
    city: geo?.city || null,
  };
}

function lookupGeo(ip) {
  if (!ip) return null;
  // Express reports IPv4 visitors on a dual-stack socket as ::ffff:1.2.3.4
  return geoip.lookup(ip.replace(/^::ffff:/, ''));
}
