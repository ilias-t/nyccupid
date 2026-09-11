// Monitor strategy for the in-person marriage-license pickup appointment
// (NYC City Clerk's Manhattan office — what "City Hall" maps to in this
// scheduler; there is no option literally labeled "City Hall"). See
// src/pickupClient.js for the underlying Salesforce Aura request mechanics.
import { bootstrapAuraContext, fetchOfficeLocationId, getSlotsForDate } from '../pickupClient.js';

export const monitorName = 'pickup';
export const label = 'pickup';
export const requiresSession = false;
export const entryUrl = 'https://clerkscheduler.cityofnewyork.us/s/MarriageLicense';
export const flowType = 'Marriage License';

// Sanity cap on the watch range: per-day querying means N days in range = N
// requests per poll cycle against an unauthenticated endpoint with no visible
// rate-limit headers (unlike the virtual monitor's Unqork x-ratelimit-*).
// Refuse a silently-abusive range rather than fan out unbounded.
const MAX_WATCH_DAYS = 21;

function addDaysIso(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Plain integer date-math day count — never `new Date(...)` diffing on
// YYYY-MM-DD strings, which parses as UTC midnight and can be off if either
// side's Date object was constructed some other way.
function daysBetween(startStr, endStr) {
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000);
}

function enumerateWatchDates(watchStart, watchEnd) {
  const dates = [];
  let d = watchStart;
  while (d <= watchEnd) {
    dates.push(d);
    d = addDaysIso(d, 1);
  }
  return dates;
}

export function loadConfig(env) {
  const officeLabel = env.CUPID_PICKUP_OFFICE_LABEL;
  const watchStart = env.WATCH_PICKUP_START_DATE;
  const watchEnd = env.WATCH_PICKUP_END_DATE;
  const missing = ['CUPID_PICKUP_OFFICE_LABEL', 'WATCH_PICKUP_START_DATE', 'WATCH_PICKUP_END_DATE'].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required .env vars for pickup: ${missing.join(', ')}`);
  }
  const dateShape = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateShape.test(watchStart) || !dateShape.test(watchEnd) || watchStart > watchEnd) {
    throw new Error('WATCH_PICKUP_START_DATE/WATCH_PICKUP_END_DATE must be YYYY-MM-DD with start <= end.');
  }
  const spanDays = daysBetween(watchStart, watchEnd);
  if (spanDays > MAX_WATCH_DAYS) {
    throw new Error(
      `WATCH_PICKUP_START_DATE/WATCH_PICKUP_END_DATE spans ${spanDays + 1} days, over the ${MAX_WATCH_DAYS + 1}-day cap — ` +
      'this endpoint is unauthenticated with no visible rate limit and is queried once per day in range, per poll cycle. Narrow the range.',
    );
  }
  // `||`, not `??`: an override that's present but empty (an uncommented
  // CUPID_PICKUP_POLL_INTERVAL_SECONDS= with no value) is not nullish, so `??`
  // would keep the empty string, Number('') would be 0, and the floor below
  // would silently poll at 60s instead of the global interval the user set.
  const rawInterval = Number(env.CUPID_PICKUP_POLL_INTERVAL_SECONDS || env.POLL_INTERVAL_SECONDS);
  const intervalSeconds = Math.max(60, Number.isFinite(rawInterval) ? rawInterval : 75);
  return { officeLabel, watchStart, watchEnd, pollIntervalMs: intervalSeconds * 1000 };
}

// No login/session for this monitor — this just confirms the scheduler page
// loads and resolves the configured office label to its current Salesforce
// record id. Stores the result on cfg (a fresh context/relaunch never
// inherits this, so checkAvailability re-derives it if missing rather than
// assume it survived).
export async function establishSession(page, cfg) {
  const { auraContext, pageUri } = await bootstrapAuraContext(page, cfg.entryUrl);
  const locationId = await fetchOfficeLocationId(page, {
    auraContext, pageUri, flowType: cfg.flowType, officeLabel: cfg.officeLabel,
  });
  cfg._aura = { auraContext, pageUri };
  cfg.locationId = locationId;
}

export async function checkAvailability(page, cfg) {
  if (!cfg._aura || !cfg.locationId) {
    try {
      await establishSession(page, cfg);
    } catch (err) {
      return { status: 'config_error', foundDates: null, lastError: `establishSession failed: ${err.message}` };
    }
  }

  const foundDates = [];
  for (const date of enumerateWatchDates(cfg.watchStart, cfg.watchEnd)) {
    let result;
    try {
      result = await getSlotsForDate(page, { ...cfg._aura, locationId: cfg.locationId, selectedDate: date });
    } catch (err) {
      return { status: 'config_error', foundDates: null, lastError: `getSlots request failed for ${date}: ${err.message}` };
    }
    if (!result.ok) {
      // The bootstrapped aura.context/fwuid may have gone stale — force a
      // fresh bootstrap next cycle instead of retrying a dead context.
      cfg._aura = null;
      // Truncated: this string reaches a public ntfy topic and Slack via
      // poller.js, and an Aura error payload is unbounded — it can carry a full
      // server stack trace. The leading characters are what identify the fault;
      // the rest is noise nobody reads on a phone.
      const detail = JSON.stringify(result.error) ?? String(result.error);
      const brief = detail.length > 200 ? `${detail.slice(0, 200)}… (truncated)` : detail;
      return { status: 'config_error', foundDates: null, lastError: `getSlots error for ${date}: ${brief}` };
    }
    const data = result.data;
    if (!data || data.selectedDate !== date) {
      // Server substituted a different date (e.g. requested date was a
      // weekend/closed day) — this response isn't an answer about `date`.
      continue;
    }
    // dateHeader labels (e.g. "Mon 28") carry no year — but since
    // data.selectedDate already confirmed this response's week contains
    // `date`, day-of-month alone is enough to pick out the right entry
    // (unique within any 7-day span).
    const requestedDay = Number(date.split('-')[2]);
    const entry = (data.daySlotsColumns || []).find((col) => {
      const m = /(\d+)\s*$/.exec(col.dateHeader || '');
      return m && Number(m[1]) === requestedDay;
    });
    if (entry && Array.isArray(entry.slots) && entry.slots.length > 0) {
      foundDates.push({ date, slotCount: entry.slots.length });
    }
  }

  foundDates.sort((a, b) => a.date.localeCompare(b.date));
  return { status: foundDates.length > 0 ? 'found' : 'no_slots', foundDates, lastError: null };
}

export function hitUrl() {
  return entryUrl;
}

// establishSession() either resolves cfg.locationId or throws — there's no
// separate "logged in but stuck" state to re-check the way virtual has, so
// this just reflects whether establishSession's last attempt actually landed.
export function verifySession(page, cfg) {
  return Boolean(cfg._aura && cfg.locationId);
}

// Pickup has no login concept — checkAvailability never emits 'auth_error',
// so this should be unreachable. Every monitor descriptor must provide a
// reLogin so the shared auth_error-recovery branch in poller.js can call it
// unconditionally; this one exists only as a loud, defensive backstop.
export async function reLogin() {
  throw new Error('reLogin() called for the pickup monitor — this should be unreachable; pickup has no login/session.');
}
