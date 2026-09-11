// Monitor strategy for the Project Cupid virtual marriage-license appointment
// — the original monitor this project was built around. Assembles the
// generic Unqork/Playwright primitives in cupidClient.js with this flow's
// specific literals (entry URL, button labels, componentKey, endpoint).
import {
  classifyLoginState,
  isLoggedInUrl,
  navigateAndStartLogin,
  attemptAutoLogin,
  waitForLoginSuccess,
  checkAvailability as cupidCheckAvailability,
  getMonthYearPairs,
  redactUrl,
} from '../cupidClient.js';

export const monitorName = 'virtual';
export const label = 'virtual';
export const requiresSession = true;

export const entryUrl = 'https://projectcupid.cityofnewyork.us/app/cupidceremony#/display/5f21c6447d42630218ccbccb';
export const entryButtonLabel = 'Marriage License (virtual)';
export const loginButtonLabel = 'Log in and continue application';
export const appUrlPattern = /\/app\/cupid#\/display\//;
export const authenticatedBaseUrl = 'https://projectcupid.cityofnewyork.us/app/cupid#/display';
export const componentKey = 'plugGetAvailabilty';
export const formTitle = 'Cupid: Couple License Portal';
export const schedulerRelativeUrl = 'scheduler/availability';
export const appVersion = '8.2.8.1';

// Below this many requests left in the current rate-limit window, log a
// warning so a run of tight polling doesn't silently walk into a 429.
const RATE_LIMIT_WARN_THRESHOLD = 500;

// Sanity cap on the watch range — see the check in loadConfig for the why.
const MAX_WATCH_MONTHS = 12;

// `mode` is 'run' (background poller) or 'login' (interactive). It decides
// whether NYC_ID_PASSWORD counts as required. The poller logs itself back in
// on every launch — see the sessionStorage note above reLogin — so unattended
// running is impossible without a stored password, and failing here with a
// clear message beats starting successfully and then looping on an
// auth_error alert that tells the user to run `login`, which cannot fix it.
export function loadConfig(env, { mode = 'run' } = {}) {
  const required = ['NYC_ID_USERNAME', 'CUPID_VIRTUAL_EVENT_ID', 'CUPID_VIRTUAL_SUBMISSION_ID', 'CUPID_VIRTUAL_FORM_ID', 'CUPID_VIRTUAL_APPLICATION_ID', 'WATCH_VIRTUAL_START_DATE', 'WATCH_VIRTUAL_END_DATE'];
  if (mode === 'run') required.push('NYC_ID_PASSWORD');
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    const passwordHint = missing.includes('NYC_ID_PASSWORD')
      ? '\n\nNYC_ID_PASSWORD is required to run the virtual monitor unattended. Project'
        + ' Cupid keeps its logged-in state only in a browser tab\'s sessionStorage, so'
        + ' the poller has to log itself back in every time it starts — a session saved'
        + ' by `./bin/cupid login virtual` never survives into it. (That interactive'
        + ' login command still works with the password left blank; only the background'
        + ' poller needs it stored.)'
      : '';
    throw new Error(`Missing required .env vars for virtual: ${missing.join(', ')}${passwordHint}`);
  }

  const watchStart = env.WATCH_VIRTUAL_START_DATE;
  const watchEnd = env.WATCH_VIRTUAL_END_DATE;
  const dateShape = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateShape.test(watchStart) || !dateShape.test(watchEnd) || watchStart > watchEnd) {
    throw new Error('WATCH_VIRTUAL_START_DATE/WATCH_VIRTUAL_END_DATE must be YYYY-MM-DD with start <= end.');
  }

  // checkAvailability issues one request per calendar month overlapping the
  // range, every cycle, forever — so an over-wide window is a permanent
  // multiplier on request volume against an authenticated endpoint. pickup caps
  // its own range for the same reason; this is the month-shaped equivalent.
  // Deliberately generous: real watch windows are weeks, not years.
  const [sy, sm] = watchStart.split('-').map(Number);
  const [ey, em] = watchEnd.split('-').map(Number);
  const monthsSpanned = (ey - sy) * 12 + (em - sm) + 1;
  if (monthsSpanned > MAX_WATCH_MONTHS) {
    throw new Error(
      `WATCH_VIRTUAL_START_DATE/WATCH_VIRTUAL_END_DATE spans ${monthsSpanned} calendar months, over the `
      + `${MAX_WATCH_MONTHS}-month cap — each month in range costs one request per poll cycle. Narrow the range.`,
    );
  }

  // `||`, not `??`: an override that's present but empty (an uncommented
  // CUPID_VIRTUAL_POLL_INTERVAL_SECONDS= with no value) is not nullish, so `??`
  // would keep the empty string, Number('') would be 0, and the floor below
  // would silently poll at 60s instead of the global interval the user set.
  const rawInterval = Number(env.CUPID_VIRTUAL_POLL_INTERVAL_SECONDS || env.POLL_INTERVAL_SECONDS);
  // Never let a missing/non-numeric interval collapse to 0 or NaN — that
  // would turn setTimeout into an immediate-fire hot loop against the API.
  const intervalSeconds = Math.max(60, Number.isFinite(rawInterval) ? rawInterval : 75);

  return {
    eventId: env.CUPID_VIRTUAL_EVENT_ID,
    submissionId: env.CUPID_VIRTUAL_SUBMISSION_ID,
    formId: env.CUPID_VIRTUAL_FORM_ID,
    applicationId: env.CUPID_VIRTUAL_APPLICATION_ID,
    watchStart,
    watchEnd,
    pollIntervalMs: intervalSeconds * 1000,
  };
}

// Deep-link straight to this application's scheduling step, bypassing the
// public landing page + click-through entirely. If the persisted session is
// still valid this loads the authenticated couple portal directly; if it has
// expired, the SPA/SSO redirects to a /auth/... URL, which classifyLoginState
// correctly reports as auth_redirect on the very next check.
function schedulingPageUrl(cfg) {
  return `${authenticatedBaseUrl}/${cfg.formId}/${cfg.submissionId}/${cfg.applicationId}`;
}

export function hitUrl(cfg) {
  return schedulingPageUrl(cfg);
}

// Used by poller.js's relaunchContext to confirm establishSession actually
// landed on an authenticated page — establishSession itself swallows a
// reLogin failure rather than throw (see its own comment), so this is the
// only place that turns "still not logged in after a relaunch" into a
// retryable failure instead of silently resuming an unauthenticated context.
export function verifySession(page, cfg) {
  return isLoggedInUrl(page.url(), { formId: cfg.formId, submissionId: cfg.submissionId, applicationId: cfg.applicationId, appUrlPattern });
}

// BUG (found live, 2026-09-06): Project Cupid's own "you're logged in" state
// lives only in the browser tab's sessionStorage (confirmed by inspecting
// the profile: no cookie ever exists for projectcupid.cityofnewyork.us, and
// every browser relaunch gets a fresh sessionStorage namespace for that
// origin — even a headed relaunch against the same .pw-user-data-virtual
// profile lands straight back on /auth/login). So a `./bin/cupid login
// virtual` run's session is already gone by the time any later process —
// including the poller — so much as starts. The poller has to log itself
// back in, in this same process, rather than trust anything `login` left
// behind on disk.
export async function reLogin(page, cfg) {
  const loginCheck = { formId: cfg.formId, submissionId: cfg.submissionId, applicationId: cfg.applicationId, appUrlPattern };
  const username = process.env.NYC_ID_USERNAME;
  const password = process.env.NYC_ID_PASSWORD;
  if (!password) {
    throw new Error('NYC_ID_PASSWORD is not set — cannot log in unattended; run `./bin/cupid login virtual` manually');
  }
  await navigateAndStartLogin(page, { entryUrl, entryButtonLabel, loginButtonLabel });
  // BUG (found live, 2026-09-07T19:11Z and 19:32Z): a NYC.ID session that's
  // actually still valid makes this click-through bounce straight through
  // SSO and back to the authenticated app with no password form ever
  // rendered — attemptAutoLogin then sits waiting 15s for a textbox that was
  // never coming, "fails", and the caller reports a false session-expired
  // alert even though nothing needed fixing. Both times, the auth_error that
  // triggered this call wasn't a real logout — the availability API just
  // returned a transient response that (before the config_error/auth_error
  // split) got misread as one. Check before filling a form that may not exist.
  if (isLoggedInUrl(page.url(), loginCheck)) return;
  const submitted = await attemptAutoLogin(page, { username, password });
  if (!submitted) {
    // The SSO bounce can also land during attemptAutoLogin's own 15s fill
    // timeout — recheck before treating the timeout as a real failure.
    if (isLoggedInUrl(page.url(), loginCheck)) return;
    throw new Error('automated login submit failed (selectors may have changed) — check `./bin/cupid login virtual` manually');
  }
  await waitForLoginSuccess(page, { ...loginCheck, timeoutMs: 60000 });
}

// Navigates a freshly-launched context to the scheduling page and logs in if
// needed — run once per fresh context (startup, or after a relaunch), never
// per cycle.
export async function establishSession(page, cfg) {
  // A fresh persistent-context page starts at about:blank, not wherever the
  // last session left off — without this, isLoggedInUrl(page.url()) would
  // read "about:blank" forever and every cycle would misreport auth_error,
  // even with a perfectly valid saved session. Headless, so this is invisible
  // and doesn't touch focus; done once per context, not per cycle.
  try {
    await page.goto(schedulingPageUrl(cfg), { waitUntil: 'domcontentloaded', timeout: 30000 });
    // The SPA validates the session and can client-side-redirect to a login
    // URL a moment after domcontentloaded fires — give that a beat to settle
    // before the first cycle reads page.url(), or a valid session could get
    // misread as auth_error on the very first check.
    await page.waitForTimeout(2000);
  } catch (err) {
    // Leave it to the reLogin attempt below (or the first checkAvailability(),
    // if that also fails) to report auth_error/error — no need to
    // special-case it here.
    console.warn(`Initial navigation failed (${err.message}); will attempt login anyway.`);
  }

  // See reLogin()'s comment above: a freshly-launched process is never
  // actually authenticated, regardless of what a prior `./bin/cupid login
  // virtual` run saved to disk — log in here, in this same process, before
  // the first cycle runs.
  if (!isLoggedInUrl(page.url(), { formId: cfg.formId, submissionId: cfg.submissionId, applicationId: cfg.applicationId, appUrlPattern })) {
    try {
      console.log('Not authenticated yet — logging in...');
      await reLogin(page, cfg);
      console.log('Logged in.');
    } catch (err) {
      console.warn(`Startup login failed (${err.message}); will resolve as auth_error on first cycle.`);
    }
  }
}

// One poll cycle resolves to exactly one of found / no_slots / auth_error /
// config_error — a non-200 status, missing/malformed JSON, or a page that's
// been redirected off /app/cupid must never be logged as if it were an empty
// no_slots day. auth_error and config_error are deliberately distinct:
// auth_error means "not authenticated" (retried automatically via reLogin);
// config_error means "demonstrably authenticated, but the request/deep-link
// IDs are wrong" — reLogin can never fix that, and must never be attempted
// for it (see poller.js's runPoller for why calling reLogin on a config_error
// cycle would itself be actively harmful, not just wasted effort).
export async function checkAvailability(page, cfg) {
  const currentUrl = page.url();
  const loginState = classifyLoginState(currentUrl, {
    formId: cfg.formId, submissionId: cfg.submissionId, applicationId: cfg.applicationId, appUrlPattern,
  });
  if (loginState !== 'authenticated') {
    const status = loginState === 'wrong_ids' ? 'config_error' : 'auth_error';
    return { status, foundDates: null, lastError: `${loginState} (url: ${redactUrl(currentUrl)})` };
  }

  const foundDates = [];
  let rateLimitWarning = null;

  for (const { month, year } of getMonthYearPairs(cfg.watchStart, cfg.watchEnd)) {
    const result = await cupidCheckAvailability(page, {
      eventId: cfg.eventId,
      submissionId: cfg.submissionId,
      formId: cfg.formId,
      applicationId: cfg.applicationId,
      month,
      year,
      schedulerRelativeUrl,
      componentKey,
      formTitle,
      appVersion,
    });

    const usable = result.status === 200 && result.json && Array.isArray(result.json.availabilityTimeslots);
    if (!usable) {
      // Surface the rate-limit headers here too, not just on a 200 below —
      // otherwise a bad response (like a 403) gives us zero evidence either
      // way on whether it was rate-limit-related.
      const rateLimitNote = result.rateLimitRemaining != null
        ? ` x-ratelimit-remaining=${result.rateLimitRemaining}/${result.rateLimitLimit}`
        : '';
      // We already confirmed loginState === 'authenticated' above — a bad
      // response here means the request/config itself is wrong, not that
      // we're logged out.
      return {
        status: 'config_error',
        foundDates: null,
        lastError: `Bad response for ${month}/${year}: status=${result.status} isSuccess=${result.json?.isSuccess}${rateLimitNote}`,
      };
    }

    const remaining = Number(result.rateLimitRemaining);
    if (Number.isFinite(remaining) && remaining < RATE_LIMIT_WARN_THRESHOLD) {
      rateLimitWarning = `x-ratelimit-remaining=${result.rateLimitRemaining} (limit=${result.rateLimitLimit})`;
    }

    for (const day of result.json.availabilityTimeslots) {
      const dateStr = String(day.eventDate).slice(0, 10);
      if (dateStr >= cfg.watchStart && dateStr <= cfg.watchEnd && Array.isArray(day.slots) && day.slots.length > 0) {
        foundDates.push({ date: dateStr, slotCount: day.slots.length });
      }
    }
  }

  foundDates.sort((a, b) => a.date.localeCompare(b.date));
  return {
    status: foundDates.length > 0 ? 'found' : 'no_slots',
    foundDates,
    lastError: null,
    rateLimitWarning,
  };
}
