import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, '..', 'logs', 'notify.log');

// Load .env from the project root explicitly rather than relying on cwd —
// the caller (bin/cupid, launchd, a shell alias) may run us from anywhere,
// and a cwd-relative dotenv load would silently skip SLACK_WEBHOOK_URL.
loadDotenv({ path: path.join(__dirname, '..', '.env'), quiet: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Unref'd so this optional wait can't hold a standalone CLI invocation open —
// unlike sleep(), this must only ever be used for non-essential background waits.
const backgroundDelay = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

async function logCall(entry) {
  try {
    await mkdir(path.dirname(LOG_PATH), { recursive: true });
    await appendFile(LOG_PATH, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // Logging must never take down the notify path — swallow and move on.
  }
}

async function showVisual(title, message) {
  try {
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`;
    await execFileAsync('osascript', ['-e', script]);
    return true;
  } catch {
    return false;
  }
}

async function playAlertSound() {
  // Focus/DND silently swallows visual notifications with no error, so a repeated
  // audible chime is the only channel guaranteed to reach the user heads-down at the Mac.
  try {
    for (let i = 0; i < 3; i++) {
      await execFileAsync('afplay', ['/System/Library/Sounds/Sosumi.aiff']);
      if (i < 2) await sleep(500);
    }
    return true;
  } catch {
    return false;
  }
}

async function openUrl(url) {
  try {
    await execFileAsync('open', [url]);
    return true;
  } catch {
    return false;
  }
}

// Per-attempt network timeout, retry count (1 initial + 2 retries), and
// backoff for the two remote channels. Neither Slack nor ntfy previously had
// any timeout at all — a single hung socket could keep a request in flight
// indefinitely, well past the point notify() had already moved on.
const REMOTE_TIMEOUT_MS = 4000;
const REMOTE_RETRY_ATTEMPTS = 3;
const REMOTE_RETRY_BACKOFF_MS = 500;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Shared retry helper for the two remote channels: a bounded per-attempt
// timeout (so a hung socket can't stall a caller that's fully awaiting this)
// plus a couple of short-backoff retries, since a single dropped packet or
// slow response should not cost us the most important alert in the system.
// Always resolves to one of true / false / 'timeout' / 'error' — callers
// must never see this hang or reject, and must never lose the distinction
// between "delivered", "server said no", "gave up on timeout", and
// "network/other error" when logging the result.
async function postWithRetry(url, options, {
  attempts = REMOTE_RETRY_ATTEMPTS,
  timeoutMs = REMOTE_TIMEOUT_MS,
  backoffMs = REMOTE_RETRY_BACKOFF_MS,
} = {}) {
  let outcome = 'error';
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.ok) return true;
      outcome = false;
    } catch (err) {
      outcome = err && err.name === 'AbortError' ? 'timeout' : 'error';
    }
    if (attempt < attempts - 1) {
      await sleep(backoffMs * (attempt + 1));
    }
  }
  return outcome;
}

async function postSlack(title, message) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return 'skipped';
  return postWithRetry(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `${title}: ${message}` }),
  });
}

// ntfy.sh push notification — this is the channel that actually reaches a
// phone while the poller runs unattended on the Mac. No account/auth needed:
// posting to a topic URL is enough, and the ntfy app (subscribed to that same
// topic) turns it into a push. Priority/tags drive how the phone surfaces it
// (urgent bypasses most phones' quiet/focus modes the way a plain push wouldn't).
async function postNtfy(title, message, url, level) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return 'skipped';
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
  const headers = {
    'Title': title,
    'Priority': level === 'found' || level === 'fatal' ? 'urgent' : level === 'auth_error' || level === 'config_error' ? 'high' : 'default',
    // 'fatal' (the poller process is exiting) is at least as urgent as an
    // auth_error (which self-heals via re-login) and gets its own tag so it
    // reads distinctly on the phone rather than as a generic warning.
    // 'config_error' (a broken request/config that retrying login can never
    // fix — see poller.js) gets its own tag too, distinct from auth_error's,
    // since the two mean different things and call for different fixes.
    'Tags': level === 'found' ? 'rotating_light' : level === 'fatal' ? 'skull' : level === 'auth_error' ? 'warning' : level === 'config_error' ? 'exclamation' : 'information_source',
  };
  if (url) headers['Click'] = url;
  return postWithRetry(`${server}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers,
    body: message,
  });
}

export async function notify({ level = 'info', title, message, url = null }) {
  // Sentinel: postSlack/postNtfy always resolve (never reject) and always
  // assign channels.slack/channels.ntfy once they do — but if we stop
  // waiting on them before that happens (the 'info' best-effort race below),
  // the log entry must still show a result for these keys, never have them
  // silently missing. 'timeout' documents "gave up waiting", distinct from
  // the 'timeout'/'error' postWithRetry itself can report once it settles.
  const channels = { slack: 'timeout', ntfy: 'timeout' };
  try {
    // Slack/ntfy: for routine levels these run best-effort in the background
    // (see the race below); for anything else notify() fully awaits them.
    const remotePromise = Promise.all([
      postSlack(title, message).then((result) => { channels.slack = result; }),
      postNtfy(title, message, url, level).then((result) => { channels.ntfy = result; }),
    ]);

    const localTasks = [showVisual(title, message).then((ok) => { channels.visual = ok; })];

    if (level === 'found' || level === 'auth_error' || level === 'config_error') {
      localTasks.push(playAlertSound().then((ok) => { channels.audio = ok; }));
    }

    if (url) {
      localTasks.push(openUrl(url).then((ok) => { channels.open = ok; }));
    }

    await Promise.all(localTasks);

    if (level === 'info') {
      // Best-effort: give Slack/ntfy a moment to finish so the log entry
      // reflects them, but don't let a routine/transient notification block
      // the poll loop beyond the local channels for long. postSlack/postNtfy
      // never reject, but we're deliberately walking away from the pending
      // promise below — guard against ever turning that into an unhandled
      // rejection. (.catch() returns a *new* promise, so the handler has to
      // be attached to, and raced via, that derived promise — the original
      // remotePromise would still have no rejection handler of its own.)
      const remoteSettled = remotePromise.catch(() => {});
      await Promise.race([remoteSettled, backgroundDelay(3000)]);
    } else {
      // Every other level (found / auth_error / fatal, and any future level
      // by default) must have remote delivery — through postSlack/postNtfy's
      // own retries — fully confirmed before notify() returns. This matters
      // most for the poller's fatal-exit path: it does `await notify(...)`
      // then `break` -> `context.close()` -> `process.exit(0)` a few lines
      // later, and process.exit() doesn't drain in-flight promises/timers.
      // Racing against a fixed timeout here would let the single most
      // important alert (the watcher died) get hard-killed mid-request.
      await remotePromise;
    }

    await logCall({ level, title, message, url, channels });
  } catch (err) {
    // notify() must never throw into the caller's poll loop.
    try {
      await logCall({ level, title, message, url, channels, error: String(err && err.message ? err.message : err) });
    } catch {
      // give up silently
    }
  }
}

function parseArgs(argv) {
  const args = { level: 'info', title: undefined, message: undefined, url: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--level') args.level = argv[++i];
    else if (arg === '--title') args.title = argv[++i];
    else if (arg === '--message') args.message = argv[++i];
    else if (arg === '--url') args.url = argv[++i];
  }
  return args;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { level, title, message, url } = parseArgs(process.argv.slice(2));
  if (!title || !message) {
    console.error('Usage: node src/notify.js --level <found|auth_error|config_error|fatal|info> --title "<title>" --message "<message>" [--url "<url>"]');
    process.exit(1);
  }
  await notify({ level, title, message, url });
}
