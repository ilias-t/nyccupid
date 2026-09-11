# nyccupid

Local watcher for NYC marriage-license appointment openings. It polls in the
background and fires a macOS notification (plus a phone push via ntfy.sh, and
optionally a Slack ping) the moment a slot opens inside the date window you
care about.

**It detects openings. It does not book them.** When something opens up you
get alerted and a browser tab opens to the right scheduling page — finishing
the booking is still yours to do.

## Which monitor do you want?

There are two, they watch two genuinely different NYC systems, and you can
run either one alone or both together.

| | **`pickup`** | **`virtual`** |
|---|---|---|
| What it watches | In-person license pickup at a City Clerk office | Project Cupid's virtual marriage-license appointment (the video interview) |
| Credentials | None whatsoever | NYC.ID email **and** a stored password |
| Browser profile | None | Persistent, saved locally |
| Setup effort | Two dates and an office name | Four IDs dug out of DevTools, plus a login step |

**If you only want `pickup`, your whole setup is:** run the two install
commands below, copy `.env.example` to `.env`, set an office name and two
dates, and run `./bin/cupid start pickup`. You can skip every `virtual`
section in this README — including the DevTools recipe, which is the one
genuinely fiddly part of this project and is not on your path at all.

What you can't skip is [Requirements](#requirements): `pickup` still needs
the Playwright Chromium binary, same as `virtual`. No login is not the same
as no install.

## Requirements

- **Node.js 20 or newer.** The floor comes from Playwright rather than from
  this project's own code (which would be happy on 18+, for global `fetch`):
  `playwright@1.63.0` declares `"engines": { "node": ">=20" }`. Be aware that
  npm only *warns* on an engine mismatch instead of failing — so on Node 18
  the install looks like it worked, and you get a confusing runtime error from
  inside `playwright-core` much later.
- **Playwright's bundled Chromium — needed by both monitors.** `npm install`
  does **not** download it. `playwright@1.63.0` ships no postinstall hook, so
  `npx playwright install chromium` is a required separate step (it's a
  ~280 MB download). This uses Playwright's own Chromium build and will not
  fall back to an installed Google Chrome.

  Yes, `pickup` needs it too, even though it's unauthenticated and makes its
  real API calls over plain `fetch()`: the poller launches a browser context
  before it branches on monitor type, so there is no browserless path. Being
  login-free doesn't make it install-free.
- **macOS for the full experience; Linux works with remote notifications
  only.** Three alert channels shell out to macOS-only commands — `osascript`
  (the visual notification), `afplay` (the chime), and `open` (the
  auto-opened booking tab). Each is individually wrapped in try/catch with no
  platform guard, so on Linux they quietly no-op while the poller and the
  Slack/ntfy push notifications keep working normally. You lose the
  at-the-Mac alerts, not the tool. The optional launchd setup is macOS-only
  too; Windows would need WSL.
- **An NYC.ID account** — only for `virtual`. `pickup` needs no account at all.
- Optional: the [ntfy](https://ntfy.sh) app on your phone, for push alerts
  while you're away from the Mac.

## Setup

Everyone starts here, whichever monitor you're running:

```
npm install
npx playwright install chromium
cp .env.example .env
```

The middle step is not optional and `npm install` will not do it for you —
see [Requirements](#requirements). Ask for `chromium` specifically rather
than running a bare `npx playwright install`, which would also pull down
Firefox and WebKit; this project never touches either.

Now open `.env` and fill in the block for the monitor you want. A monitor
whose block is empty or still holding the placeholder values refuses to
start, with a clear error naming exactly what's missing or malformed — so
it's safe to leave the other one blank.

### Setup: `pickup`

Two settings, no login, no DevTools:

- `CUPID_PICKUP_OFFICE_LABEL` — must match one of the scheduler's own
  picklist labels exactly (case-insensitive): `Bronx Office`,
  `Brooklyn Office`, `Manhattan Office`, `Queens Office`,
  `Staten Island Office`. There is no option literally labeled "City Hall";
  if that's what you mean, you want `Manhattan Office` (141 Worth Street).
- `WATCH_PICKUP_START_DATE` / `WATCH_PICKUP_END_DATE` — inclusive,
  `YYYY-MM-DD`.

Keep that window narrow. Every date in range is queried once per poll cycle,
so a wide range means a lot of requests against a public endpoint; a window
spanning more than 22 dates is refused at startup.

Then:

```
./bin/cupid start pickup
```

That's the whole thing. Skip ahead to [Day-to-day usage](#day-to-day-usage).

### Setup: `virtual`

`virtual` needs your NYC.ID credentials and four identifiers that are
specific to your own Project Cupid application.

**Credentials.** Set `NYC_ID_USERNAME` to your NYC.ID email, and
`NYC_ID_PASSWORD` to your NYC.ID password.

`NYC_ID_PASSWORD` is **required** for normal use, not the optional
convenience it looks like. Project Cupid keeps its logged-in state only in a
browser tab's `sessionStorage`, so the background poller has to log itself
back in every time it starts — a session saved by `login virtual` never
survives into it (this is explained in full under
[One-time login](#one-time-login)). Without a stored password the poller
simply cannot authenticate unattended, and `start virtual` refuses to start.

You may leave it blank only if you plan to run `login virtual` interactively
and never use the background poller — which, since the poller is the entire
point, is unlikely to be what you want.

> **Note for anyone pointing an LLM browser tool at this project:** don't.
> Some MCP-style browser-automation tools expose input values in their
> accessibility snapshots regardless of field masking, which means a password
> you type through one can end up echoed in plaintext into an LLM
> conversation transcript. This project's own login code is not one of those:
> it's plain local Node reading `.env` and calling Playwright's `fill()`
> directly, so the value never reaches any tool output or model context.

**The four IDs.** Find them once, with DevTools open (Network tab, filtered
on `execute`), on the couple portal's "Schedule a meeting" step:

1. Log in and click through to the calendar/scheduling page.
2. Open a month in the calendar — this fires the request you need.
3. In the Network tab, find the POST to
   `.../fbu/uapi/services/incus5-scheduler/execute` with `componentKey`
   `plugGetAvailabilty` in its request payload.
4. From the **request payload**: `eventId`, `submissionId`, `formId` →
   `CUPID_VIRTUAL_EVENT_ID`, `CUPID_VIRTUAL_SUBMISSION_ID`,
   `CUPID_VIRTUAL_FORM_ID`.
5. From the **request headers**: `x-application-id` →
   `CUPID_VIRTUAL_APPLICATION_ID`.

These are stable for the life of your application — you won't have to do this
again.

Finally set `WATCH_VIRTUAL_START_DATE` / `WATCH_VIRTUAL_END_DATE` (inclusive,
`YYYY-MM-DD`).

#### One-time login

```
./bin/cupid login virtual
```

This opens a **visible** browser window (Playwright's bundled Chromium, not
your everyday Chrome) and navigates to the NYC.ID login form.

- With `NYC_ID_PASSWORD` set — the normal case — it fills in both fields and
  submits. Just watch it finish.
- With it blank, it fills in your username and waits for you to type your
  password and click Login. This interactive path is the one place a blank
  password still works; the background poller has no equivalent.

Either way, once you're in it saves a persistent browser profile to
`.pw-user-data-virtual/` (gitignored) and exits. Then:

```
./bin/cupid start virtual
```

Project Cupid's own "you're logged in" state lives only in that browser tab's
`sessionStorage` — it never lands in a cookie or anywhere else that survives
a process restart, even against the same saved profile. What the saved
profile actually preserves is the underlying NYC.ID/Akamai cookies, which do
persist; the app-level login does not carry over to the next process. That's
why `start virtual` logs itself back in every time it launches, and again
automatically if a check ever comes back `auth_error` — and it's the whole
reason `NYC_ID_PASSWORD` has to be stored rather than typed. Running `login
virtual` again cannot substitute for it: whatever that command authenticates
is already gone by the time the next process starts.

So why run `login virtual` at all? It creates the browser profile directory,
which `start virtual` checks for, and it's where you find out interactively
whether your credentials actually work — with a visible window, rather than
through a failure notification an hour later. Once that's done you shouldn't
need it again. Run it manually if automatic re-login keeps failing — e.g.
NYC.ID is showing a CAPTCHA or asking for 2FA that unattended automation
can't get through.

If `virtual`'s poller is already running, `login virtual` stops it first
(Playwright holds an exclusive lock on the browser profile, so login and the
poller can't use it at the same time) and restarts it once you're logged back
in. This never touches `pickup` if it happens to be running too. If login
doesn't finish successfully — you close the window, it errors, you Ctrl-C —
the poller is left stopped rather than silently restarted with a half-finished
session; run `./bin/cupid start virtual` yourself when you're ready.

`pickup` has no login step at all. Running `./bin/cupid login pickup` prints a
short message and exits rather than opening a browser window.

## Day-to-day usage

```
./bin/cupid start <monitor>    # start polling in the background
./bin/cupid stop <monitor>     # stop the background poller
./bin/cupid stop --all         # stop every known monitor
./bin/cupid status             # is anything running? one line per monitor
./bin/cupid status <monitor>   # full detail for one monitor
./bin/cupid logs <monitor>     # tail -f that monitor's log (Ctrl-C just stops watching)
```

`<monitor>` is `virtual` or `pickup`. Every command except bare `status`
requires it — there's no "start everything" shortcut; run `start virtual` and
`start pickup` separately.

- `start <monitor>` refuses to double-start that monitor — if it's already
  running it just prints the existing pid and exits. It also refuses to start
  `virtual` if you haven't run `login virtual` yet (no saved session), or if a
  poller for that monitor is already running but untracked (started via
  `node src/poller.js run <monitor>` directly, launchd, or a stale pid
  mismatch — see `stop` below); in the
  untracked case it tells you to run `stop <monitor>` first instead of
  launching a second instance against the same browser profile. After
  launching, it waits ~2s and confirms the process is still alive before
  reporting success — if `.env` is missing a required variable for that
  monitor, the poller exits almost immediately, and `start` shows you the
  failure (tailing that monitor's stderr log) instead of falsely reporting
  success.
- `status` (no argument) prints a one-line summary per monitor — e.g.
  `virtual: running, checked 45s ago, no openings yet` /
  `pickup: FOUND: 2026-10-01 — go book now!`. `status <monitor>` prints full
  detail for just that one (raw `lastCheckAt`, `status`, `foundDates`,
  `lastError`, `checksCompleted`). It flags loudly if the last check is more
  than ~5x that monitor's poll interval old — that usually means the loop died
  silently without cleaning up its pidfile. A `found` result always leads,
  even if the process has since stopped or the check is stale.
- `stop <monitor>` sends `SIGTERM` to the tracked pid, waits up to ~5s, then
  `SIGKILL`s if it's still alive. It then also sweeps the process list for any
  other `node src/poller.js run <monitor>` process and stops that too — scoped
  to that one monitor only, so stopping `virtual` can never take down a
  running `pickup` (or vice versa). `stop --all` does this for every known
  monitor.
- Each monitor reports one of five statuses: `found` (an opening — go book
  it), `no_slots` (checked cleanly, nothing open), `auth_error` (`virtual`
  only — not currently authenticated; retries automatically), `config_error`
  (the request or config itself is broken — a wrong ID, a changed page, or any
  failure on `pickup`, which has no login concept to fail in the first place;
  retrying login can never fix this, so it alerts on its own track), or
  `error` (anything else).

State and log files this creates (all gitignored, one set per monitor):

- `.cupid-<monitor>.pid` — pidfile for `start`/`stop`/`status`
- `state-<monitor>.json` — last-check snapshot the poller writes
- `logs/poller-<monitor>.log` — structured poll log (what `logs <monitor>` tails)
- `logs/run-<monitor>.out.log` / `.err.log` — raw stdout/stderr from `start`
- `.pw-user-data-virtual/` — `virtual`'s saved browser profile (`pickup` has none)

## What happens on a hit

When a monitor finds an opening in its watch window: a loud macOS
notification and sound fire, a browser tab opens to that monitor's scheduling
page, and — if configured in `.env` — a push notification goes out via ntfy.sh
and/or a Slack message is sent.

You still have to finish the booking yourself. The tab opens in your default
browser, which is not the Playwright profile the poller uses, so for `virtual`
you may land on a login page and have to sign in again. Auto-booking is
deliberately not implemented.

Both monitors share the same Slack channel and ntfy topic, so the title and
message name which one fired (e.g. "Cupid pickup: appointment opening
found!"), and the link goes to that monitor's own scheduling page rather than
a generic shared URL.

`pickup` may take a while to ever fire, and that's expected rather than a bug:
NYC's in-person scheduler only shows real availability for dates it has
actually released — a target date can sit at "no slots" for weeks before
anything opens up, the same way `virtual`'s month view can.

### Getting a notification on your phone

The local macOS notification and sound only reach you if you're at the Mac. To
get pushed to your phone while you're out, this uses
[ntfy.sh](https://ntfy.sh) — no account or signup needed:

1. Install the **ntfy** app
   ([iOS](https://apps.apple.com/us/app/ntfy/id1625396347) /
   [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)).
2. Invent a topic name and put it in `.env` as `NTFY_TOPIC`. Don't think one
   up — generate one:

   ```
   openssl rand -hex 16
   ```

   Paste the raw hex in. **On the public ntfy.sh server, the topic name is
   the only access control there is** — anyone who knows or guesses it can
   subscribe to your notifications. So treat it like a password, not a
   username: long, random, and not prefixed with "nyccupid" or your name.
3. In the app, tap **+** and subscribe to that exact topic name.

That's it — the next `found` / `auth_error` / `config_error` notify call
pushes to your phone.

**What the push actually contains.** For `virtual`, a `found` alert's
tappable link is the authenticated deep link to your own application — it
embeds your `formId`, `submissionId`, and `applicationId` (three of the four
IDs you dug out of DevTools; `eventId` isn't in it). That's deliberate:
during a race for a slot that just opened, a link you can tap is the entire
point, and making you navigate there by hand on a phone would cost you the
appointment. But it does mean anyone who knows your topic can reach your
application's scheduling page. They can't *do* anything there — these are
identifiers, not credentials, and the page is useless without a logged-in
NYC.ID session — but factor it into how carefully you pick the topic name,
and self-host via `NTFY_SERVER` if you'd rather not have it cross a public
server at all. `pickup`'s link carries no identifiers; it's just the public
scheduler's front page.

If you'd rather use Slack instead (or as well), fill in `SLACK_WEBHOOK_URL` in
`.env` and turn on mobile notifications for that channel. No code changes
needed, it's already wired up.

You can smoke-test notifications independently of the poller:

```
node src/notify.js --level found --title "Test" --message "Hello" --url "https://example.com"
```

## Why it works this way

- **`virtual` polls through a real, logged-in browser session rather than a
  plain HTTP client.** This isn't an optimization — it's the only thing that
  works. Project Cupid's "you're logged in" state lives exclusively in the
  browser tab's `sessionStorage`; there is no cookie, header, or token to
  lift out and replay from a standalone HTTP client. Driving an actual
  browser session is the only way to make an authenticated request at all.
- **`virtual`'s login stays a real login.** Credentials go through the site's
  own NYC.ID form, filled locally by Playwright — see the note in
  [Setup: `virtual`](#setup-virtual) for why that matters and shouldn't be
  "helpfully" routed through some other automation layer.
- **`pickup` is a completely different system, not a second Project Cupid
  flow.** In-person pickup runs on `clerkscheduler.cityofnewyork.us`, a public
  Salesforce Experience Cloud site — no NYC.ID login, no Unqork IDs, a
  different request protocol entirely. `virtual` and `pickup` being
  independently start/stop-able isn't just CLI convenience: they're built on
  two genuinely different NYC systems with different auth models, not one
  backend accessed two ways. One consequence is that `pickup` needs no browser
  persistent browser profile at all — it gets a throwaway context — so
  adding it costs nothing against `virtual`'s existing session, and there's no shared rate limit between the two — they hit
  entirely unrelated services.
- **"City Hall" isn't a literal option in the pickup scheduler.** The picklist
  offers Bronx/Brooklyn/Manhattan/Queens/Staten Island offices; "Manhattan
  Office" (141 Worth Street) is the right match. It's resolved live from the
  scheduler's own picklist at each session start rather than hardcoded as an
  id, so an id change on Salesforce's side surfaces as a clear error instead
  of a silent wrong query.

### Be a good citizen

This is a polite, read-only poller against a public service that real people
depend on. Please keep it that way:

- **Don't try to poll faster.** `POLL_INTERVAL_SECONDS` has a hard floor of 60
  seconds in code — values below that are clamped up, for both monitors. 75 is
  a sensible default. An opening that's worth having is still there 75 seconds
  later.
- **Keep watch windows narrow.** `pickup` queries every date in range on every
  cycle, so the window size directly multiplies your request count; anything
  spanning more than 22 dates is refused at startup. `virtual` has no such cap
  — its month-view request covers a whole month at once — but a tight window
  still means fewer months fetched.
- **It reads, it never writes.** No booking, no cancelling, no form
  submission beyond the login you'd do by hand anyway. If you extend this,
  keep that line where it is.

## Optional: run via launchd instead of a terminal session

Most of the time, just run `./bin/cupid start <monitor>` in a terminal or tmux
session you leave open. Only bother with launchd once that's proven reliable
for you — it adds a layer of indirection that's harder to debug when
something goes wrong.

`launchd/nyccupid.virtual.plist.example` and
`launchd/nyccupid.pickup.plist.example` are templates (the `.example` suffix
means neither is auto-installed). They run the poller directly via
`node src/poller.js run <monitor>`, restart it if it dies (`KeepAlive`), and
start it at login (`RunAtLoad`).

Each template carries two placeholder tokens in place of real paths:

- `__NODE_PATH__` — the absolute path to your `node` binary. It genuinely has
  to be absolute: launchd runs with a minimal `PATH`
  (`/usr/bin:/bin:/usr/sbin:/sbin`), so a bare `node` installed by Homebrew,
  nvm, asdf, or Volta will not resolve.
- `__PROJECT_DIR__` — the absolute path to your clone. This one appears three
  times per file: `WorkingDirectory`, and both log paths. Don't hand-edit it,
  you'll miss one.

Fill in both and install, from the project root:

```
mkdir -p ~/Library/LaunchAgents

sed -e "s|__NODE_PATH__|$(command -v node)|g" -e "s|__PROJECT_DIR__|$PWD|g" \
  launchd/nyccupid.virtual.plist.example > ~/Library/LaunchAgents/nyccupid.virtual.plist

launchctl load ~/Library/LaunchAgents/nyccupid.virtual.plist
```

Repeat with `pickup` in place of `virtual` for the other monitor. Writing to a
new file rather than editing the template in place keeps the `.example`
pristine, so you can regenerate it whenever a path changes.

To disable one (independently of the other):

```
launchctl unload ~/Library/LaunchAgents/nyccupid.virtual.plist
```

If you reinstall Node or switch version managers, the baked-in `__NODE_PATH__`
goes stale and the job will fail to launch. Re-check `command -v node`, then
regenerate the plist with the same `sed` command and `launchctl unload` /
`load` it again.

Logs from a launchd-managed process go to `logs/launchd-<monitor>.out.log` and
`logs/launchd-<monitor>.err.log`, separate from `bin/cupid start`'s own logs.

Don't run both `bin/cupid start <monitor>` and launchd for the *same* monitor
at once: `bin/cupid stop <monitor>`'s process-list sweep will also stop a
launchd-managed instance of that monitor, and launchd's `KeepAlive` will
immediately restart it — `stop` will look like it worked while the poller keeps
going. Running `virtual` under launchd and `pickup` from a terminal (or vice
versa) is fine; they're fully independent.

## Disclaimer

This is an unofficial third-party tool. It is not affiliated with, endorsed
by, or supported by the City of New York, the Office of the City Clerk, or
Project Cupid.

It works by reading undocumented endpoints that were never meant for
third-party use. They can change, break, or start refusing requests at any
time, with no notice and no obligation to anyone. When that happens this tool
will stop working — possibly loudly, possibly by quietly never reporting an
opening again. Don't make it the only thing standing between you and an
appointment you need. Use at your own risk.

## License

MIT — see [LICENSE](LICENSE).
