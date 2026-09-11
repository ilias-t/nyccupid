import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.join(__dirname, '..');

// Matches the authenticated couple-portal shell for the virtual monitor
// (/app/cupid#/display/<formId>/<submissionId>/<applicationId>). The
// pre-login "Get your Marriage License online" landing page is ALSO served
// under /app/cupid#/display/<oneId> (BUG found live, 2026-09-06) — requiring
// all three known IDs in the URL makes this specific to the real
// authenticated page, not just the app shell in general.
const DEFAULT_APP_URL_PATTERN = /\/app\/cupid#\/display\//;

// Splits what a single boolean used to conflate: "on an auth/login redirect"
// vs. "on the right authenticated app page but with the wrong deep-link IDs."
// The latter means demonstrably logged in but pointed at a misconfigured
// eventId/formId/submissionId/applicationId — a config problem, never an auth
// one — and must never be treated as the former (see poller.js's runCycle for
// why conflating them silently swallows a misconfigured monitor with no alert
// ever firing).
export function classifyLoginState(url, { formId, submissionId, applicationId, appUrlPattern } = {}) {
  if (!formId || !submissionId || !applicationId) {
    throw new Error('classifyLoginState requires formId, submissionId, and applicationId to avoid a false-positive match');
  }
  if (/\/auth\//.test(url)) return 'auth_redirect';
  const pattern = appUrlPattern ?? DEFAULT_APP_URL_PATTERN;
  if (!pattern.test(url)) return 'not_on_app';
  const idsMatch = url.includes(formId) && url.includes(submissionId) && url.includes(applicationId);
  return idsMatch ? 'authenticated' : 'wrong_ids';
}

// Thin wrapper kept for the simple yes/no callers (waitForLoginSuccess,
// selfLogin's early-return guards) that only ever care about the fully-happy
// path.
export function isLoggedInUrl(url, opts) {
  return classifyLoginState(url, opts) === 'authenticated';
}

// requiresSession monitors (virtual) get an exclusive-locked persistent
// profile so NYC.ID/Akamai cookies survive a process restart. Monitors with
// no login concept (pickup) get a plain, non-persistent context — no profile
// directory, no lock, nothing to leave on disk. Callers must close whichever
// fields come back: `browser` is only present (and only needs closing) for
// the non-persistent path.
export async function launchContext(cfg, { headless }) {
  if (cfg.profileDir) {
    const context = await chromium.launchPersistentContext(cfg.profileDir, { headless });
    const page = context.pages()[0] ?? (await context.newPage());
    return { context, page };
  }
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, browser, page };
}

// Closes whatever launchContext() returned — safe to call on either shape
// (browser is undefined for a persistent context, and closing a context
// alone would otherwise leak the underlying Chromium process for the
// non-persistent/no-session case).
export async function closeLaunched({ context, browser }) {
  await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}

// Drives only the pre-login clicks (no secrets involved). Falls through to
// the URL-wait loop on failure since a human is already watching the visible
// window and can click through manually.
export async function navigateAndStartLogin(page, { entryUrl, entryButtonLabel, loginButtonLabel }) {
  try {
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: entryButtonLabel }).click({ timeout: 15000 });
    await page.getByRole('button', { name: loginButtonLabel }).click({ timeout: 15000 });
  } catch (err) {
    console.warn(
      `Automated navigation didn't complete (${err.message}) — click through it yourself in the window.`,
    );
  }
}

export async function prefillUsername(page, username) {
  if (!username) return;
  try {
    await page
      .getByRole('textbox', { name: 'Email Address or Username' })
      .fill(username, { timeout: 15000 });
  } catch (err) {
    console.warn(`Could not pre-fill username (${err.message}) — type it in yourself.`);
  }
}

// Optional convenience path: only runs if NYC_ID_PASSWORD is actually set in
// .env (gitignored, local-only). This is plain Node code calling Playwright's
// fill() directly — the value never passes through any tool output or LLM
// context, which is what the "never automate the password field" concern is
// actually about: an LLM-driven browser tool can echo a typed password into a
// conversation transcript, because its accessibility snapshot exposes input
// values regardless of whether the field renders masked. Leaving
// NYC_ID_PASSWORD blank in .env keeps the fully-manual flow.
export async function attemptAutoLogin(page, { username, password }) {
  if (!password) return false;
  try {
    if (username) {
      await page.getByRole('textbox', { name: 'Email Address or Username' }).fill(username, { timeout: 15000 });
    }
    await page.getByRole('textbox', { name: 'Password Password *' }).fill(password, { timeout: 15000 });
    await page.getByRole('button', { name: 'Login' }).click({ timeout: 15000 });
    return true;
  } catch (err) {
    console.warn(`Automated login submit failed (${err.message}) — log in manually in the window.`);
    return false;
  }
}

// timeoutMs is null (wait forever) for the interactive manual-login flow,
// where a human is watching and will eventually finish the form. The poller's
// unattended self-login passes a real timeout so a stuck/changed login page
// can't hang the whole process with no human there to notice.
// Error strings built in this file and in the monitors are broadcast verbatim
// to ntfy and Slack by the poller (see its notify calls) and persisted to the
// state/log files, so a URL must never be interpolated into one raw. An
// interrupted NYC.ID SSO round-trip can leave `code`, `state`, or `id_token`
// in the query or fragment, and the authenticated app deep link carries the
// user's own form/submission/application ids in its fragment. On the public
// ntfy.sh server the topic name is the only access control, so treat anything
// that reaches notify() as published. Keep origin + path — enough to identify
// which page the flow stalled on — and drop everything after it.
export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    const redacted = u.search || u.hash ? ' (params redacted)' : '';
    return `${u.origin}${u.pathname}${redacted}`;
  } catch {
    return '<unparseable url redacted>';
  }
}

export async function waitForLoginSuccess(page, { formId, submissionId, applicationId, appUrlPattern, pollIntervalMs = 1000, timeoutMs = null }) {
  const startedAt = Date.now();
  for (;;) {
    if (isLoggedInUrl(page.url(), { formId, submissionId, applicationId, appUrlPattern })) return;
    if (timeoutMs != null && Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for login (url: ${redactUrl(page.url())})`);
    }
    await page.waitForTimeout(pollIntervalMs);
  }
}

// Runs the fetch from inside the authenticated page (not a bare Node HTTP
// client) because that is the only place the session actually exists: Project
// Cupid keeps its logged-in state in the page's sessionStorage, alongside the
// cookies a real page load establishes. A cold request from Node carries none
// of it and simply isn't authenticated.
export async function checkAvailability(page, {
  eventId, submissionId, formId, applicationId, month, year,
  schedulerRelativeUrl, componentKey, formTitle, appVersion,
}) {
  const requestBody = {
    url: schedulerRelativeUrl,
    params: { eventId, month, year, timezone: 'America/New_York' },
    headers: {},
    requestType: 'get',
    options: {},
    componentKey,
    formTitle,
    submissionId,
    formId,
    body: {},
  };

  return page.evaluate(
    async ({ endpoint, body, applicationId, appVersion }) => {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          accept: 'application/json, text/plain, */*',
          // Mirrors the request the app's own UI issues — the Unqork gateway
          // is multi-tenant and may use this to route the call to the right
          // application context even with a valid session.
          'x-application-id': applicationId,
          'x-app-version': appVersion,
        },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const json = await r.json().catch(() => null);
      return {
        status: r.status,
        json,
        rateLimitRemaining: r.headers.get('x-ratelimit-remaining'),
        rateLimitLimit: r.headers.get('x-ratelimit-limit'),
      };
    },
    { endpoint: '/fbu/uapi/services/incus5-scheduler/execute', body: requestBody, applicationId, appVersion },
  );
}

// Enumerates every (month, year) pair overlapping [startDate, endDate] as
// plain integer arithmetic — never via `new Date(...)`, which parses
// YYYY-MM-DD as UTC midnight and can land on the wrong calendar day (and
// therefore the wrong month) once shifted into America/New_York.
export function getMonthYearPairs(startDate, endDate) {
  const [startY, startM] = startDate.split('-').map(Number);
  const [endY, endM] = endDate.split('-').map(Number);

  const pairs = [];
  let y = startY;
  let m = startM;
  while (y < endY || (y === endY && m <= endM)) {
    pairs.push({ month: String(m), year: String(y) });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return pairs;
}
