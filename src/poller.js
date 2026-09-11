import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs/promises';
import { PROJECT_ROOT, launchContext, closeLaunched, navigateAndStartLogin, attemptAutoLogin, prefillUsername, waitForLoginSuccess } from './cupidClient.js';
import { getMonitor, MONITOR_NAMES } from './monitors/index.js';
import { notify } from './notify.js';

loadEnv({ path: path.join(PROJECT_ROOT, '.env') });

// Caps on relaunching a dead browser context mid-loop (see runPoller()'s
// `cycle.fatal` handling). RELAUNCH_MAX_ATTEMPTS bounds one relaunch episode
// (e.g. Chromium binary missing/corrupted, disk full) so it can't spin
// forever. MAX_CONSECUTIVE_RELAUNCHES bounds how many separate fatal
// episodes in a row we'll paper over — without it, a flapping environment
// (context dying every cycle) would relaunch and redo a real login forever,
// hammering the target site instead of surfacing the problem.
const RELAUNCH_MAX_ATTEMPTS = 5;
const RELAUNCH_BASE_DELAY_MS = 3000;
const MAX_CONSECUTIVE_RELAUNCHES = 3;
// A re-login attempt can fail on an unlucky timing race (e.g. mid-flight SSO
// redirect skipping the login form entirely) even when the underlying
// session is actually fine — confirmed live on 2026-09-07T19:11Z, where the
// very next cycle came back healthy with no further action taken. Retrying
// only once per auth_error streak (the original behavior) would leave the
// poller stuck forever whenever that race isn't so lucky. AUTH_RETRY_EVERY_CYCLES
// retries periodically instead of every single cycle (which would hammer
// the target site for no reason); AUTH_ALERT_REPEAT_EVERY_RETRIES throttles the
// human-facing alert so a genuinely stuck streak doesn't push every retry,
// just an initial heads-up and periodic reminders.
const AUTH_RETRY_EVERY_CYCLES = 4; // ~5 min at the default 75s poll interval
const AUTH_ALERT_REPEAT_EVERY_RETRIES = 6;
// config_error means "demonstrably not an auth problem" (wrong deep-link IDs,
// a broken request, a monitor with no login concept at all) — retrying login
// can never fix it, so there's no retry cadence here, only an alert cadence:
// skip a one-off blip, then alert, then remind periodically.
const CONFIG_ERROR_ALERT_AFTER_CYCLES = 3;
const CONFIG_ERROR_ALERT_REPEAT_EVERY_CYCLES = 20;

function monitorPaths(monitorName, requiresSession) {
  return {
    profileDir: requiresSession ? path.join(PROJECT_ROOT, `.pw-user-data-${monitorName}`) : null,
    statePath: path.join(PROJECT_ROOT, `state-${monitorName}.json`),
    logPath: path.join(PROJECT_ROOT, 'logs', `poller-${monitorName}.log`),
  };
}

async function appendLog(logPath, entry) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
}

async function loadState(statePath) {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastCheckAt: parsed.lastCheckAt ?? null,
      status: parsed.status ?? null,
      foundDates: Array.isArray(parsed.foundDates) ? parsed.foundDates : [],
      alertedDates: Array.isArray(parsed.alertedDates) ? parsed.alertedDates : [],
      lastError: parsed.lastError ?? null,
      checksCompleted: Number.isFinite(parsed.checksCompleted) ? parsed.checksCompleted : 0,
    };
  } catch {
    return {
      lastCheckAt: null,
      status: null,
      foundDates: [],
      alertedDates: [],
      lastError: null,
      checksCompleted: 0,
    };
  }
}

async function persistState(statePath, state) {
  const tmpPath = `${statePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2));
  await fs.rename(tmpPath, statePath);
}

// `mode` ('run' | 'login') is forwarded to the monitor's loadConfig because
// the two entry points don't require the same things: the background poller
// needs credentials it can use unattended, while `login` is interactive and
// deliberately tolerates a blank password the user types in themselves.
function loadRunConfig(monitorName, mode = 'run') {
  if (!MONITOR_NAMES.includes(monitorName)) {
    console.error(`Unknown monitor "${monitorName}" — known monitors: ${MONITOR_NAMES.join(', ')}`);
    process.exit(1);
  }
  const monitor = getMonitor(monitorName);
  let monitorConfig;
  try {
    monitorConfig = monitor.loadConfig(process.env, { mode });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const { profileDir, statePath, logPath } = monitorPaths(monitorName, monitor.requiresSession);
  // `...monitor` spreads the module's constants and functions (entryUrl,
  // establishSession, checkAvailability, reLogin, verifySession, hitUrl,
  // etc.) alongside the env-derived instance fields — this single merged
  // object is threaded everywhere below as `cfg`, so a monitor's strategy
  // functions and its config never have to be passed around separately.
  return { monitorName, ...monitor, ...monitorConfig, profileDir, statePath, logPath };
}

// establishSession() is expected to try its best and warn rather than throw
// (virtual's reLogin failure is deliberately swallowed so the first cycle can
// detect and report auth_error/config_error normally) — but a monitor's
// establishSession isn't guaranteed to honor that (pickup's does throw, on a
// genuine setup failure), so this call site never assumes either way.
async function tryEstablishSession(page, cfg) {
  try {
    await cfg.establishSession(page, cfg);
  } catch (err) {
    console.warn(`establishSession failed (${err.message}); will resolve on first cycle.`);
  }
}

function interruptibleSleep(ms) {
  let cancel;
  const promise = new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    cancel = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, cancel };
}

// Relaunches a brand-new context + page and runs establishSession() against
// it, retrying with backoff up to RELAUNCH_MAX_ATTEMPTS times. Returns null
// once exhausted so the caller can fall back to the original log/notify/exit
// behavior instead of hanging forever on a truly broken environment.
//
// Deliberately does NOT just relaunch the context and let the loop's normal
// `cycle.status !== prevStatus` transition guard notice and recover: if
// state.status was already e.g. 'auth_error' going into the crash and comes
// back 'auth_error' again post-relaunch, that guard sees no transition and
// never fires — the poller would sit broken forever with no retry and no
// alert. Calling establishSession() synchronously here, and verifying via
// cfg.verifySession() that it actually landed correctly before returning,
// closes that hole: the loop only ever resumes once a real recovery attempt
// has happened against the new context.
async function relaunchContext(cfg, { shouldStop } = {}) {
  for (let attempt = 1; attempt <= RELAUNCH_MAX_ATTEMPTS; attempt++) {
    if (shouldStop && shouldStop()) return null;
    let launched;
    try {
      launched = await launchContext(cfg, { headless: true });
      await tryEstablishSession(launched.page, cfg);
      if (!cfg.verifySession(launched.page, cfg)) {
        throw new Error('session was not established after relaunch');
      }
      return launched;
    } catch (err) {
      console.warn(`Context relaunch attempt ${attempt}/${RELAUNCH_MAX_ATTEMPTS} failed: ${err.message}`);
      if (launched) await closeLaunched(launched).catch(() => {});
      if (attempt < RELAUNCH_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RELAUNCH_BASE_DELAY_MS * attempt));
      }
    }
  }
  return null;
}

async function runPoller(monitorName) {
  const cfg = loadRunConfig(monitorName);
  // The three local alert channels shell out to macOS-only binaries (osascript,
  // afplay, open) and each swallows its own failure so a dead channel can never
  // throw into the poll loop. That silence is right at alert time and wrong at
  // startup: off a Mac you would otherwise get no signal at all that the
  // at-the-desk alerts are inert. Say it once, here, and keep going — Slack and
  // ntfy are plain fetch and still work.
  if (process.platform !== 'darwin') {
    console.warn(
      `Not running on macOS (platform: ${process.platform}) — the local notification, `
      + 'sound, and auto-open-tab alerts will not fire. Set NTFY_TOPIC and/or '
      + 'SLACK_WEBHOOK_URL in .env, or you will not be alerted at all.',
    );
  }
  let launched = await launchContext(cfg, { headless: true });
  let { context, browser, page } = launched;

  await tryEstablishSession(page, cfg);

  const state = await loadState(cfg.statePath);

  let stopping = false;
  let cancelSleep = null;
  // Counts consecutive fatal-and-relaunched episodes with no successful
  // cycle in between (reset below whenever a cycle actually completes) — see
  // MAX_CONSECUTIVE_RELAUNCHES above for why this exists.
  let consecutiveRelaunches = 0;
  // Reset whenever the status changes away from the one being tracked (not
  // just on success) — see the found/no_slots branch below for why a bare
  // "only reset on success" would let a status that flaps against 'error'
  // masquerade as a brand-new streak on every return, defeating the
  // every-N-cycles retry/alert throttling.
  let consecutiveAuthErrorCycles = 0;
  let authErrorRetryCount = 0;
  let consecutiveConfigErrorCycles = 0;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}, finishing current cycle and closing browser context...`);
    if (cancelSleep) cancelSleep();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  while (!stopping) {
    let cycle;
    try {
      cycle = await cfg.checkAvailability(page, cfg);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      cycle = {
        status: 'error',
        foundDates: null,
        lastError: message,
        // Once the page/context is gone every future cycle fails identically —
        // stop looping instead of spinning forever on a dead browser.
        fatal: /Target (page, context or browser has been closed|closed)/i.test(message),
      };
    }

    const prevStatus = state.status;
    const nowIso = new Date().toISOString();
    state.lastCheckAt = nowIso;
    state.status = cycle.status;
    state.lastError = cycle.lastError;
    state.checksCompleted += 1;

    if (prevStatus !== 'auth_error') { consecutiveAuthErrorCycles = 0; authErrorRetryCount = 0; }
    if (prevStatus !== 'config_error') consecutiveConfigErrorCycles = 0;

    if (cycle.status === 'found' || cycle.status === 'no_slots') {
      // A real, completed cycle — any flapping window is over.
      consecutiveRelaunches = 0;
      const dateList = cycle.foundDates.map((d) => d.date);
      const newDates = dateList.filter((d) => !state.alertedDates.includes(d));
      state.foundDates = dateList;
      // Re-set (rather than union) alertedDates to the current openings: a
      // date that closes drops out, so if it reopens later it reads as new
      // again and re-fires — while a still-open date never re-fires.
      state.alertedDates = dateList;

      await appendLog(cfg.logPath, { status: cycle.status, foundDates: dateList, checksCompleted: state.checksCompleted });
      if (cycle.rateLimitWarning) {
        await appendLog(cfg.logPath, { level: 'warn', message: `Rate limit low: ${cycle.rateLimitWarning}` });
      }

      if (newDates.length > 0) {
        const summary = cycle.foundDates
          .filter((d) => newDates.includes(d.date))
          .map((d) => `${d.date} (${d.slotCount} slot${d.slotCount === 1 ? '' : 's'})`)
          .join(', ');
        await notify({
          level: 'found',
          title: `Cupid ${cfg.label}: appointment opening found!`,
          message: `New availability: ${summary}`,
          url: cfg.hitUrl(cfg),
        });
      }
    } else if (cycle.status === 'auth_error') {
      await appendLog(cfg.logPath, { status: cycle.status, lastError: cycle.lastError, checksCompleted: state.checksCompleted });
      consecutiveAuthErrorCycles += 1;
      const isNewStreak = cycle.status !== prevStatus;
      // Retry on the first cycle of a new streak, then periodically (every
      // AUTH_RETRY_EVERY_CYCLES cycles) rather than only once ever — see the
      // constants' comment for why a single miss can't be the last attempt
      // forever.
      if (isNewStreak || consecutiveAuthErrorCycles % AUTH_RETRY_EVERY_CYCLES === 0) {
        authErrorRetryCount += 1;
        let reloginError = null;
        try {
          console.log(`auth_error detected (re-login attempt ${authErrorRetryCount}) — attempting automatic re-login...`);
          await cfg.reLogin(page, cfg);
          console.log('Re-login succeeded — resuming polling.');
        } catch (err) {
          reloginError = err.message;
          console.warn(`Automatic re-login failed (${reloginError}).`);
        }
        // Alert on the first failure, then only every
        // AUTH_ALERT_REPEAT_EVERY_RETRIES-th retry after that — retries
        // themselves stay frequent so we recover as soon as possible, but
        // the human doesn't need a push every ~5 minutes while that's
        // ongoing, just an initial heads-up and periodic reminders.
        if (reloginError && (authErrorRetryCount === 1 || authErrorRetryCount % AUTH_ALERT_REPEAT_EVERY_RETRIES === 0)) {
          await notify({
            level: 'auth_error',
            title: `Cupid ${cfg.label}: session expired`,
            message: `Automatic re-login failed (${reloginError}) after ${authErrorRetryCount} attempt${authErrorRetryCount === 1 ? '' : 's'} — run \`./bin/cupid login ${cfg.monitorName}\` manually.`,
            url: null,
          });
        }
      }
    } else if (cycle.status === 'config_error') {
      // Never call reLogin here: config_error means we're either
      // demonstrably authenticated with wrong deep-link IDs, or (for a
      // monitor with no login concept at all, like pickup) a broken
      // request/config — reLogin cannot fix either, and for virtual, calling
      // it anyway would needlessly navigate the page away from a page that
      // was already fine, risking a fresh false auth_error on the next cycle.
      consecutiveRelaunches = 0;
      consecutiveConfigErrorCycles += 1;
      await appendLog(cfg.logPath, { status: cycle.status, lastError: cycle.lastError, checksCompleted: state.checksCompleted });
      if (consecutiveConfigErrorCycles === CONFIG_ERROR_ALERT_AFTER_CYCLES ||
          consecutiveConfigErrorCycles % CONFIG_ERROR_ALERT_REPEAT_EVERY_CYCLES === 0) {
        await notify({
          level: 'config_error',
          title: `Cupid ${cfg.label}: request failing`,
          message: `checkAvailability has failed for ${consecutiveConfigErrorCycles} consecutive cycles (latest: ${cycle.lastError}) — check this monitor's config, not its login.`,
          url: null,
        });
      }
    } else {
      // Any other/unknown status.
      await appendLog(cfg.logPath, { status: cycle.status, lastError: cycle.lastError, checksCompleted: state.checksCompleted });
      if (cycle.status !== prevStatus) {
        await notify({
          level: 'info',
          title: `Cupid ${cfg.label}: poller error`,
          message: cycle.lastError || 'Unknown error',
          url: null,
        });
      }
    }

    await persistState(cfg.statePath, state);

    if (cycle.fatal) {
      console.error('Fatal error:', cycle.lastError);
      // The old context/page are gone (Target closed) — best-effort close
      // (it may already be dead) and relaunch rather than exit the whole
      // process: nothing supervises this (no launchd, plain nohup via
      // `bin/cupid start`), so a bare exit here sits dead until a human
      // notices and restarts it manually.
      await closeLaunched({ context, browser }).catch(() => {});

      if (stopping) break; // shutdown already requested — no point relaunching just to exit again

      const relaunched = await relaunchContext(cfg, { shouldStop: () => stopping });
      if (!relaunched && stopping) break; // aborted for shutdown, not exhaustion — no alert needed

      if (relaunched) {
        ({ context, browser, page } = relaunched);
        consecutiveRelaunches += 1;
        console.log(`Context relaunched and re-established (consecutive relaunch #${consecutiveRelaunches}) — resuming polling.`);
        await appendLog(cfg.logPath, { level: 'warn', message: `Relaunched browser context after fatal error: ${cycle.lastError}` });
      }

      if (!relaunched || consecutiveRelaunches > MAX_CONSECUTIVE_RELAUNCHES) {
        const reason = relaunched
          ? `context keeps dying right after relaunch (${consecutiveRelaunches}x in a row)`
          : 'exhausted context relaunch attempts';
        console.error(`${reason} — giving up.`);
        await notify({
          // 'fatal' awaits remote delivery in full before the process.exit(0)
          // below can cut it off, instead of racing a best-effort timeout.
          level: 'fatal',
          title: `Cupid ${cfg.label}: poller crashed`,
          message: `Poller is exiting and nothing will restart it — ${reason}. Last error: ${cycle.lastError}. Run \`./bin/cupid start ${cfg.monitorName}\` manually.`,
          url: null,
        });
        break;
      }
      // Fall through to the normal sleep below instead of looping straight
      // back into another cycle — guarantees a floor between real login/
      // request attempts even if the environment is flapping.
    }
    if (stopping) break;

    const { promise, cancel } = interruptibleSleep(cfg.pollIntervalMs);
    cancelSleep = cancel;
    await promise;
    cancelSleep = null;
  }

  await closeLaunched({ context, browser }).catch(() => {});
  process.exit(0);
}

async function runLogin(monitorName) {
  const cfg = loadRunConfig(monitorName, 'login');
  if (!cfg.requiresSession) {
    console.error(`${monitorName}: no login step — this monitor doesn't use a persistent browser session.`);
    process.exit(1);
  }
  const { context, page } = await launchContext(cfg, { headless: false });
  process.on('SIGINT', async () => {
    await context.close().catch(() => {});
    process.exit(130);
  });
  process.on('SIGTERM', async () => {
    await context.close().catch(() => {});
    process.exit(143);
  });

  try {
    await navigateAndStartLogin(page, { entryUrl: cfg.entryUrl, entryButtonLabel: cfg.entryButtonLabel, loginButtonLabel: cfg.loginButtonLabel });

    const username = process.env.NYC_ID_USERNAME;
    const password = process.env.NYC_ID_PASSWORD;
    const autoSubmitted = await attemptAutoLogin(page, { username, password });

    if (autoSubmitted) {
      console.log('Submitted saved credentials — waiting for login to complete...');
    } else {
      await prefillUsername(page, username);
      console.log('Log in in the browser window that just opened (type your own password yourself — set NYC_ID_PASSWORD in .env to skip this next time).');
    }

    await waitForLoginSuccess(page, {
      formId: cfg.formId,
      submissionId: cfg.submissionId,
      applicationId: cfg.applicationId,
      appUrlPattern: cfg.appUrlPattern,
    });
    console.log('Login successful, session saved.');
    await context.close();
    process.exit(0);
  } catch (err) {
    console.error('Login flow error:', err.message);
    await context.close().catch(() => {});
    process.exit(1);
  }
}

const mode = process.argv[2];
const monitorName = process.argv[3];
if (!monitorName || (mode !== 'login' && mode !== 'run')) {
  console.error(`Usage: node src/poller.js <login|run> <monitor>\nKnown monitors: ${MONITOR_NAMES.join(', ')}`);
  process.exit(1);
}
if (mode === 'login') {
  await runLogin(monitorName);
} else {
  await runPoller(monitorName);
}
