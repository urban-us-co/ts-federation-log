/**
 * ts-federation-log — shared helpers
 * Used by both collector.js (POST path) and import.js (download path) so a
 * record looks identical no matter how it entered the log.
 */

const crypto = require('crypto');

// Hash an identifier into a short, stable, non-reversible id. Derived from the
// high-entropy UUID (falling back to email) so the public log can still group
// by user/org without exposing the raw UUID or email address.
const anonId = (s) => (s ? crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12) : null);

// Redact email addresses embedded in free-text fields (e.g. a personal org is
// auto-named "<email>'s Organization", which would otherwise leak the email).
const scrubEmail = (s) => (s ? String(s).replace(/[\w.+-]+@[\w.-]+\.\w+/g, '[redacted]') : (s ?? null));

// Pull a flat, query-friendly record out of one org's /usage payload.
// Input: a "raw record" { ts, user_*, org_*, raw: <usage payload> }
function flatten(rec) {
  const u = rec.raw || {};
  const minor = (m) => (m && typeof m.amount_minor === 'number' ? m.amount_minor / 100 : null);
  return {
    ts: rec.ts,
    recorded_by: rec.recorded_by || 'bookmarklet',
    user_id: anonId(rec.user_uuid || rec.user_email), // hashed; raw uuid/email never written
    user_name: scrubEmail(rec.user_name),
    org_id: anonId(rec.org_uuid),                      // hashed
    org_name: scrubEmail(rec.org_name),
    five_hour_pct: u.five_hour ? u.five_hour.utilization : null,
    five_hour_resets_at: u.five_hour ? u.five_hour.resets_at : null,
    weekly_all_pct: u.seven_day ? u.seven_day.utilization : null,
    weekly_all_resets_at: u.seven_day ? u.seven_day.resets_at : null,
    weekly_sonnet_pct: u.seven_day_sonnet ? u.seven_day_sonnet.utilization : null,
    weekly_sonnet_resets_at: u.seven_day_sonnet ? u.seven_day_sonnet.resets_at : null,
    spend_used_usd: u.spend ? minor(u.spend.used) : null,
    spend_limit_usd: u.spend ? minor(u.spend.limit) : null,
    spend_pct: u.spend ? u.spend.percent : null,
    extra_usage_enabled: u.extra_usage ? !!u.extra_usage.is_enabled : null,
    raw: u,
  };
}

// A record is uniquely identified by who+which-org+when. Used to de-dupe on
// import. Works on both raw input records (have user_uuid/org_uuid) and already
// flattened/anonymized rows (have user_id/org_id).
const dedupeKey = (r) =>
  `${r.user_id || r.user_uuid || r.user_email || '?'}|${r.org_id || r.org_uuid || '?'}|${r.ts}`;

const isValidRaw = (r) => r && r.raw && r.org_uuid && r.ts;

module.exports = { flatten, anonId, dedupeKey, isValidRaw };
