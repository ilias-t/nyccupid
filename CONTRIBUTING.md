# Contributing

This is a small personal-scale tool. Issues and PRs are welcome; there's no
CLA, no style bot, and no review SLA.

## Running it locally

```
npm install
npx playwright install chromium
cp .env.example .env
```

You need Node 20+, and the `playwright install` step is mandatory — `npm
install` doesn't fetch the browser binary. Both monitors need it, including
`pickup`. See the README's Requirements section for why.

`.npmrc` sets `engine-strict=true`, so an unsupported Node version fails the
install outright instead of printing a warning you scroll past. One thing to
know if it ever fires unexpectedly: npm applies that setting to every
*dependency's* `engines` range, not just this project's. All of ours are
open-ended today, so it can only reject a version that genuinely won't work —
but if a dependency ever pins an upper bound, you can get past it with
`npm install --engine-strict=false`.

Then fill in `.env` and run a monitor — see the README for the full setup.

**Use `pickup` for development.** It's the contributor-testable path: a
public, unauthenticated scheduler, so you need no NYC.ID account, no browser
profile, and none of the DevTools ID-hunting that `virtual` requires. Set
`CUPID_PICKUP_OFFICE_LABEL` and a narrow two- or three-day window and you can
exercise the entire poll loop — config load, session bootstrap, request,
status classification, state file, log line — end to end:

```
./bin/cupid start pickup
./bin/cupid logs pickup     # expect a `no_slots` line within one poll interval
./bin/cupid stop pickup
```

Working on `virtual` needs a real, in-progress Project Cupid application of
your own. There's no fixture or mock for it, and there won't be one until
someone builds it.

## There are no tests yet

Nothing to run, nothing to break. Until that changes, "tested" means you
manually smoke-tested the path you touched and said so in the PR.

The notification path can be exercised on its own, without the poller:

```
node src/notify.js --level found --title "Test" --message "Hello" --url "https://example.com"
```

That fires the real local notification and, if configured, really posts to
Slack and ntfy — so point it at a throwaway topic if you're iterating.

If you do add tests, a test runner and a `test` script in `package.json` are
a welcome PR on their own.

## A good first PR: Linux support

The poller is portable already. What isn't is `src/notify.js`, which shells
out to three macOS-only commands — `osascript` for the visual notification,
`afplay` for the chime, and `open` for the auto-opened booking tab. Each is
wrapped in try/catch with no platform guard, so today they just silently
no-op elsewhere while Slack and ntfy keep working.

Swapping those three wrappers for a `process.platform` switch (`notify-send`
and friends on Linux) is a small, well-scoped change and a genuinely useful
one. Keep the existing catch-and-continue behavior — `notify()` must never
throw into the poll loop.

## Reporting bugs

The NYC endpoints this talks to are undocumented and not intended for
third-party use. They change without notice, and when they do, this project
breaks — usually as a `config_error` streak or a monitor that suddenly never
reports `found`. That means a bug report is much more useful with evidence
than without:

- what you ran and what you expected
- the relevant lines from `logs/poller-<monitor>.log`
- `./bin/cupid status <monitor>` output

**Redact before you paste.** The logs and status output can contain your
watch dates, and error strings can echo request details. Strip anything
that identifies your application — the four `CUPID_VIRTUAL_*` IDs, your
`NTFY_TOPIC`, your Slack webhook URL, your NYC.ID email.

## Ground rules for PRs

- **Never commit a real `.env`**, a real ntfy topic, a real Slack webhook, or
  real appointment/application IDs — not in code, not in a test fixture, not
  in a pasted log. `.env` is gitignored; keep it that way.
- **No personal paths or names** in committed files. The launchd templates and
  `.env.example` use placeholders on purpose.
- **This tool detects openings. It does not book them.** That's a deliberate
  line, not an unfinished feature. A PR that adds auto-booking changes what
  this project is and how it interacts with a city government system — open
  an issue and get agreement on the approach first, before writing it.
- Keep the polling polite: the 60-second floor on `POLL_INTERVAL_SECONDS` and
  the watch-window cap on `pickup` are there to stop this from becoming a
  nuisance to a public service. PRs that remove or weaken either one need a
  good reason.
- Match the surrounding code. It's plain ES modules, no framework, no build
  step, and comments explain *why* rather than *what* — several of them
  document live-observed behavior of the NYC endpoints, which is the most
  valuable thing in the file. Keep that habit.
