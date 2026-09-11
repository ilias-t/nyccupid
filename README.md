# nyccupid

Watches for NYC marriage-license appointment openings and alerts you the
moment a slot opens in your date range — macOS notification, phone push via
ntfy.sh, optionally Slack.

**It detects openings. It does not book them.** You get an alert and a browser
tab on the right page; finishing the booking is yours.

## Two monitors

| | **`pickup`** | **`virtual`** |
|---|---|---|
| Watches | In-person license pickup at a City Clerk office | Project Cupid's virtual appointment (the video interview) |
| Credentials | None | NYC.ID email + stored password |
| Setup | An office name and two dates | Four IDs from DevTools, plus a login step |

Genuinely different NYC systems, run independently — either alone or both.
**`pickup` needs no account and no DevTools work**: set an office and two
dates and you're running.

## Requirements

- **Node 20+.** Playwright's floor, not this project's. npm only *warns* on a
  version mismatch, so on Node 18 you get a confusing runtime error rather
  than a failed install.
- **Playwright's Chromium** (~280 MB) — `setup` below fetches it. Both
  monitors need it, `pickup` included: the poller launches a browser before it
  branches on monitor type, so there is no browserless path.
- **macOS** for the local alerts (`osascript`, `afplay`, `open`) and for
  launchd. On Linux they quietly no-op; the poller runs and ntfy/Slack fire.
- **An NYC.ID account** — `virtual` only.

## Setup

```
./bin/cupid setup
```

Installs dependencies, fetches Chromium, and creates `.env` from the example.
Safe to re-run — it never overwrites an existing `.env`. (It's a command
rather than an npm `postinstall` hook on purpose: a ~280 MB download should
happen because you asked for it, not as a side effect of `npm install`.)

Then fill in `.env` for the monitor you want. A monitor whose block is empty
or still on placeholder values refuses to start, naming the exact variable.

### pickup

Two settings, no login:

- `CUPID_PICKUP_OFFICE_LABEL` — one of `Bronx Office`, `Brooklyn Office`,
  `Manhattan Office`, `Queens Office`, `Staten Island Office`. There's no
  "City Hall" option; that's `Manhattan Office` (141 Worth Street).
- `WATCH_PICKUP_START_DATE` / `WATCH_PICKUP_END_DATE` — inclusive,
  `YYYY-MM-DD`. Every date in range is queried on every cycle, so keep it
  tight; a window over 22 dates is refused.

```
./bin/cupid start pickup
```

### virtual

Set `NYC_ID_USERNAME`, `NYC_ID_PASSWORD`, and `WATCH_VIRTUAL_START_DATE` /
`WATCH_VIRTUAL_END_DATE`.

`NYC_ID_PASSWORD` is **required**, not a convenience: Project Cupid keeps its
logged-in state only in a browser tab's `sessionStorage`, so the poller logs
itself back in on every launch, and `start virtual` refuses to run without it.
(Only the interactive `login virtual` still works with it blank.) Storing it
is safe — `.env` is gitignored and read only by local code. Avoid typing it
into an LLM-driven browser tool, which may expose it despite field masking.

Then the four IDs. Open DevTools (Network tab, filter on `execute`) on the
couple portal's "Schedule a meeting" step:

1. Log in and click through to the calendar page.
2. Open a month in the calendar — this fires the request you need.
3. Find the POST to `.../fbu/uapi/services/incus5-scheduler/execute` with
   `componentKey` `plugGetAvailabilty` in its payload.
4. **Request payload** → `eventId`, `submissionId`, `formId`.
5. **Request headers** → `x-application-id`.

Those four go into `CUPID_VIRTUAL_EVENT_ID`, `CUPID_VIRTUAL_SUBMISSION_ID`,
`CUPID_VIRTUAL_FORM_ID` and `CUPID_VIRTUAL_APPLICATION_ID`, and are stable for
the life of your application — you only do this once.

```
./bin/cupid login virtual    # visible window, one time only
./bin/cupid start virtual
```

`login virtual` creates the browser profile `start` checks for, and lets you
confirm interactively that your credentials work.

## Usage

| | |
|---|---|
| `./bin/cupid setup` | install dependencies and Chromium, create `.env` |
| `./bin/cupid login virtual` | log in to NYC.ID (`virtual` only, one time) |
| `./bin/cupid start <monitor>` | start polling in the background |
| `./bin/cupid stop <monitor>` | stop it (`stop --all` stops every monitor) |
| `./bin/cupid status [monitor]` | one line per monitor, or full detail for one |
| `./bin/cupid logs <monitor>` | follow that monitor's log |

`<monitor>` is `virtual` or `pickup`; there's no "start everything" shortcut.
Starting or stopping one never affects the other.

Statuses: `found` (go book it), `no_slots`, `auth_error` (`virtual` only;
retries itself), `config_error` (a wrong ID or a changed page — logging in
again can't fix it), `error`.


## Alerts

On a hit: a loud macOS notification and sound, a browser tab on that monitor's
scheduling page, and — if configured — an ntfy push and/or a Slack message. The
tab opens in your default browser, not the poller's profile, so for `virtual`
you may have to sign in again.

`pickup` can take a long time to ever fire — expected, not a bug: NYC only
shows availability for dates it has actually released.

### Phone push

Install the ntfy app ([iOS](https://apps.apple.com/us/app/ntfy/id1625396347) /
[Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)),
generate a topic name into `.env` as `NTFY_TOPIC`, and subscribe to it:

```
openssl rand -hex 16
```

**On public ntfy.sh the topic name is the only access control there is** —
anyone who knows or guesses it can subscribe, so treat it like a password.
`virtual`'s alert also links straight to your application (embedding your
`formId`, `submissionId` and `applicationId`), so a leaked topic exposes that
page — useless without your NYC.ID login, but worth knowing. Self-host via
`NTFY_SERVER` to avoid the public server; `pickup`'s link has no identifiers.

For Slack instead or as well, set `SLACK_WEBHOOK_URL`. Both channels can be
smoke-tested without the poller — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Please poll politely

This reads a public service real people depend on. `POLL_INTERVAL_SECONDS`
has a hard floor of 60 seconds (lower values are clamped up), `pickup` caps
its watch window at 22 dates, and the tool only ever reads. If you extend it,
keep it that way.

## Optional: launchd

`launchd/nyccupid.virtual.plist.example` and
`launchd/nyccupid.pickup.plist.example` start a monitor at login and restart it
if it dies. Each holds two placeholders: `__NODE_PATH__` (launchd's `PATH` is
minimal, so `node` must be absolute) and `__PROJECT_DIR__`, which appears three
times per file — so use `sed`, don't hand-edit. From the project root:

```
mkdir -p ~/Library/LaunchAgents

sed -e "s|__NODE_PATH__|$(command -v node)|g" -e "s|__PROJECT_DIR__|$PWD|g" \
  launchd/nyccupid.virtual.plist.example > ~/Library/LaunchAgents/nyccupid.virtual.plist

launchctl load ~/Library/LaunchAgents/nyccupid.virtual.plist
```

Repeat with `pickup`; `launchctl unload` disables. Don't run both
`bin/cupid start <monitor>` and launchd for the same monitor — `stop` will look
like it worked while `KeepAlive` quietly restarts it.

## Disclaimer

Unofficial third-party tool, not affiliated with or endorsed by the City of
New York, the Office of the City Clerk, or Project Cupid. It reads
undocumented endpoints that can change or break at any time with no notice —
and when that happens it may fail by quietly never reporting an opening again.
Don't make it the only thing between you and an appointment you need.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
