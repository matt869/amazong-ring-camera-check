# Ring Check-in

[![CI](https://github.com/matt869/amazong-ring-camera-check/actions/workflows/ci.yml/badge.svg)](https://github.com/matt869/amazong-ring-camera-check/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Ring alerts you when something happens. Ring Check-in alerts you when something that should happen doesn't.**

It's for the adult child working in another city whose mother lives alone. She doesn't want a camera watching her, and you don't want more notifications. You want quiet reassurance on normal days, and a fast, clear signal on the day something is off.

Ring Check-in learns her everyday routine from Ring doorbell, camera and sensor activity. It uses the *times* of activity, never video. It notices when a day looks different: a late start, a long quiet spell, an outing that runs long, a door opening at night. When that happens it follows a response plan rather than sounding an alarm:

1. **It asks her first.** A friendly "are you OK?" text with a one-tap reply.
2. **Family is told** if she hasn't replied after 15 minutes.
3. **A neighbor is asked to knock** after 30 minutes if nobody in the family has checked.

It also watches for what no single day shows:
- **Routine drift.** Getting up a little later each week, going out less, moving around less.
- **Visitor patterns.** Repeated unexpected callers at the door, a common start to scams that target older adults.

Each week, everyone who shares the caring gets a **family digest**: how her week went, who called or visited, and anything worth a conversation. She has **her own page** showing exactly what's shared, where she can pause it.

## Quick start

Requires Node.js 22.13 or newer. It uses the built-in `node:sqlite`, so there are no native modules to compile.

```bash
npm install
npm run seed      # optional: 9 weeks of simulated routine
npm run dev       # http://localhost:3000
```

With no Ring credentials configured, the app runs in **demo mode**. It sets up a simulated household with six devices, nine weeks of history (a home aide on Tuesday and Thursday mornings, deliveries, a family that calls in), and new activity arriving through the day. Messages are printed to the server log, and the daily note and weekly digest come from built-in templates.

To see each alert, open **Settings → Demo scenario**, or reseed:

```bash
npm run seed -- --scenario late-start          # missed-morning alert, then an all-clear 10 minutes later
npm run seed -- --scenario quiet-morning       # no activity at all today
npm run seed -- --scenario inactive-afternoon  # activity stops after 11am
npm run seed -- --scenario long-outing         # goes out at 1pm and doesn't come back
npm run seed -- --scenario night-door          # back door opened at 2:40am
npm run seed -- --scenario gradual-decline     # six weeks of later mornings and fewer outings (see Trends)
npm run seed -- --scenario repeat-visitor      # an unexpected caller keeps coming back (visitor alert)
```

To watch events arrive live, run the simulator in a second terminal while the dashboard is open:

```bash
npm run simulate              # one event every 4 seconds, as signed Ring webhooks
npm run simulate -- --every 2 --loop
```

The dashboard and timeline show each event within about two seconds, briefly highlighted. Movement from a webcam sensor appears the same way.

To see the escalation ladder in demo mode, add a phone number for her and a neighbor under **Settings → If a day looks different**. With SNS off, each text goes to the server log, including the one-tap reply link you can open.

## Set up a webcam (no Ring needed)

Any spare laptop, tablet or phone with a camera works. Movement is detected **on that device**; only the times of movement are sent, never video or pictures.

1. Start the app (`npm run build && npm start`) and open **Set up**.
2. Choose a dashboard password.
3. Click **Add a webcam** and pick the room it will watch (usually the kitchen).
4. On the device at the home, scan the QR code (or open the link), tap **Start watching**, and allow the camera.
5. Leave it plugged in, facing the room, with the page open. The screen stays on while watching.

The missed-morning check starts the morning after the first webcam checks in. A camera set up at noon never saw that morning, so it won't text her about it.

Adding the first webcam replaces the demo data. If every webcam stops checking in (unplugged, Wi-Fi down, page closed), caregivers get a **monitoring offline** alert. They never get a false "no activity" alarm. Resident alerts are held back until data flows again.

### Using a webcam on another device

Browsers only give web pages camera access over **https**, or on the same computer that runs the app (`http://localhost`). So:
- **The app's computer is at the home and has a webcam:** open the sensor link on that computer. Nothing else is needed.
- **The sensor is a different device:** the app must be reachable at an https address. A free option is a Cloudflare quick tunnel (`npx cloudflared tunnel --url http://localhost:3000`), which prints an `https://….trycloudflare.com` address. Set `APP_URL` to it, restart, and generate a new link on the Set up page. The same address also lets family open the dashboard from their phones.

Limits of a single webcam: it sees one room and can't see in the dark. It also can't tell when the person leaves the house, so the "out longer than expected" rule needs a door sensor (Ring) to work.

## Or connect a Ring account

```bash
npm run ring:login     # you type your Ring email, password and the 2FA code; nothing goes through anyone else
npm run build && npm start
```

The sign-in script saves only the long-lived token Ring issues (`RING_REFRESH_TOKEN` in `.env.local`). It asks you to choose a dashboard password if one isn't set yet. The app then connects as that account, read-only:
- doorbell presses and camera motion arrive as push notifications;
- Ring Alarm door/window contacts and motion sensors come over the alarm's live connection;
- camera history is backfilled every 15 minutes.

Ring rotates the token periodically; the app stores each new one so the connection survives restarts.

- **Whose account?** Use the account that owns her devices, or your own account if she has added you as a **Shared User** in the Ring app (Control Center > Shared Users).
- **Revoking access:** remove "Ring Check-in" under Control Center > Authorized Client Devices in the Ring app.
- **Run one copy** of the app per token. Two copies refreshing the same token will log each other out.
- **If the connection drops,** the dashboard says so, `/api/health` returns 503, and caregivers get a "can't reach Ring" alert after 15 minutes. Alerts about her are held back while no data is flowing, so an outage never looks like a quiet day. If it doesn't recover, run `npm run ring:login` again.
- This uses the community [`ring-client-api`](https://github.com/dgreif/ring) package. It isn't an official Ring API: it can break when Ring changes their service, and it may conflict with Ring's terms of service.

## Before relying on it

1. **Set `APP_PASSWORD`.** The dashboard shows when someone is home alone or out. With Ring credentials configured and no password, the app stays locked.
2. **Serve it over HTTPS** and set `APP_URL` to the https address. Session cookies are then marked Secure.
3. **Send a test alert** from Settings to confirm SNS reaches every caregiver.
4. **Check the device list** in Settings. Untick any device that sees people other than the resident, such as a camera facing the street. Doorbells are off by default.
5. **Give it a few days.** Until 3 days of history exist, the app uses the fallback wake time and fixed daytime hours.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build && npm start` | Production build and server |
| `npm test` | Unit and integration tests |
| `npm run typecheck` | TypeScript check |
| `npm run seed` | Reset and seed demo data (`--days N`, `--scenario name`) |
| `npm run simulate` | Send a morning of Ring-style events to the running app, live (`--every N`, `--loop`, `--url`) |
| `npm run ring:login` | Sign in to Ring once and save the access token |

## How it works

```
Ring webhook ─┐                                     ┌─► new alert ─────► SNS (SMS/email)
Ring history ─┼─► events ─► routine (14 days) ─► rules ─► reminder ─────► SNS
Demo feed ────┘   SQLite    + presence (home/out)   └─► all-clear ─────► SNS
                                                       dashboard + daily note (Bedrock)
```

**Activity.** Only devices marked "counts as their activity" are used to decide whether the resident is up and about. Doorbell motion is excluded by default, because a delivery driver must never clear a missed-morning alert.

**Routine** ([lib/routine/baseline.ts](lib/routine/baseline.ts)) is learned from the last N full days:
- the usual wake time, and the late end of a normal morning (90th percentile)
- which hours are normally active
- the average movement per hour
- the typical longest quiet gap

**Presence** ([lib/routine/presence.ts](lib/routine/presence.ts)). The resident counts as out when a door opens and the house then stays quiet. They count as back when a door opens again.

**Rules** ([lib/routine/detect.ts](lib/routine/detect.ts)):

| Rule | Fires when | Severity | Clears when |
|---|---|---|---|
| No morning activity | No movement past the later of usual wake time + grace, or the late end of a normal morning | urgent | They move |
| Long quiet period | At home, no movement for N hours during normally active hours | notify | They move or go out |
| Out longer than expected | Out for N hours, or still out when night starts | notify | They come home |
| Door opened at night | An exterior door opens during night hours | notify | Someone acknowledges it |
| Device offline | Ring reports it disconnected, or an indoor motion sensor goes silent for 2 days while other rooms are active | dashboard | It reports again |
| Low battery | Battery at or below the threshold | dashboard | Battery is replaced |
| Lost connection to Ring | Ring unreachable for 15 minutes; alerts about her are held back meanwhile | notify | The connection is restored |
| Unexpected visitors | 3+ unexpected callers she opened the door to in 7 days, at least twice her usual rate | notify | Someone acknowledges it |

**Escalation ladder** ([lib/escalation.ts](lib/escalation.ts)). Routine alerts follow a response plan, not a broadcast:

| Rung | When | Who | Message |
|---|---|---|---|
| 1 | The alert opens | Her, by SMS | "Hi Mom, it's your family's check-in… Tap to let us know you're OK", with a one-tap link |
| 2 | No reply after `caregiverAfterMinutes` (15) | Family (SNS topic) | The alert, plus "Mom didn't reply to a check-in text sent at 9:00am" |
| 3 | `neighborAfterMinutes` (30) after it began, and no family member has marked it as checked | The neighbor, by SMS | "Could you knock on the door? Tap here once you've checked" |

- **The ladder stops** when she taps "I'm OK", when the situation clears by itself (she moves, comes home), or when someone in the family presses "I checked on it". Whoever was already contacted gets the all-clear, and a neighbor is told they needn't knock.
- **"Please call me"** on her reply page goes to family at once. **"I couldn't reach them"** from the neighbor does the same.
- **The neighbor hears her name, not yours for her.** Messages to the neighbor say "Ana", not "Mom" (Settings: *What the neighbor calls Mom*).
- **If the check-in text can't be sent** (bad number, SMS outage), family is told right away instead of waiting for a reply that can't come.
- **Not every alert climbs every rung.** A door opening at night goes straight to family, and nobody asks a neighbor to knock while she's out. The per-rule flags are in [lib/routine/rules.ts](lib/routine/rules.ts).
- **The reply link** is HMAC-signed, expires after a day, and needs no login. Opening it changes nothing, because phones preview links automatically; only pressing a button answers.
- **Answering for the day.** Once she has replied "I'm OK", the same situation (say, today's missed morning) isn't raised again.

**Routine drift** ([lib/routine/drift.ts](lib/routine/drift.ts)). Daily rules compare today with a 14-day routine, so a slow decline gradually becomes "normal". Drift compares the last two weeks with the four weeks before, using the same activity filter and outing detection as the daily rules:

| Finding | Fires when |
|---|---|
| Getting up later | Typical wake time is 30+ minutes later. "A little later each week" when it rose in 4 of the last 5 weeks |
| Getting up earlier | 45+ minutes earlier |
| Going out less often | Outings per week fell to 60% or less, and by at least one |
| Moving around less at home | Movements per day fell to 75% or less |
| More movement at night | 1.5+ more movements a night, and at least double |

Days with any pause (away, or a privacy pause) are left out, so a week at a daughter's house doesn't look like a decline. Findings appear on the dashboard, on **Trends**, and in the weekly digest. They are not alerts: they're worth a conversation, not a phone call.

**Visitor awareness** ([lib/routine/visitors.ts](lib/routine/visitors.ts)). A visit is a doorbell press, or Ring flagging someone loitering. Motion alone is a passer-by. Each visit is classified as:
- **Expected:** matches a line in Settings, such as `Home aide: Tue Thu 9:30-11:00`.
- **Regular:** at about the same time and weekday in 3 of the previous 4 weeks. These are learned, with no setup.
- **Rang, no answer:** short, and no door opened, which is likely a delivery.
- **Unexpected:** anything else.

A door opening within 10 minutes means she answered, unless that opening started or ended an outing (her leaving isn't answering). Three or more unexpected callers she opened the door to in a week, and at least twice her usual rate, raise an **Unexpected visitors** alert to family, at most once per week. No faces or video are used, so "unexpected" means outside any known pattern, not "a stranger".

**Weekly family digest** ([lib/digest.ts](lib/digest.ts)). It's sent to the SNS topic on the chosen day and time (Sunday 6pm by default), and shown on **Week**. It covers:
- her routine against the week before
- **who checked in:** calls and visits family members log in one tap on the dashboard, plus who answered alerts, and which days nobody was in touch
- alerts and how each was resolved
- unexpected visitors
- drift findings

Claude on Bedrock writes it from these pre-computed facts, falling back to a template.

**Her own page** ([app/me/[key]/page.tsx](app/me/%5Bkey%5D/page.tsx)). This is a private link family creates in Settings, in plain language and large type. It shows exactly what's shared (which rooms and doors, today's note), who is told and when, and what was sent about her this week. She can **pause sharing** for an hour, three hours, or until tomorrow morning. While paused, nothing is recorded, not even events Ring's history delivers later. Family sees *that* it's paused, not why, and can't end her pause early. The doorbell picture can only be switched on here, by her.

**Alert lifecycle** ([lib/checkin.ts](lib/checkin.ts)):
- Each situation raises one alert.
- An alert clears only with real evidence that things are fine. Silence lasting until midnight is not an all-clear.
- Pushed alerts are followed by an "All clear" message when they resolve.
- Urgent alerts that family hasn't acknowledged get one reminder `reminderMinutes` after family was told.
- **Pause** ("staying with family this week") stops the resident alerts. Device-health alerts keep running.

**Scheduler** ([instrumentation.ts](instrumentation.ts)). Every `CHECK_INTERVAL_MINUTES`, it:
- re-runs the rules
- in real mode, refreshes device status and battery from Ring every 30 minutes
- pulls recent history every 15 minutes as a backstop for missed webhooks
- prunes events older than 120 days

**Daily note** ([lib/aws/bedrock.ts](lib/aws/bedrock.ts)). With `BEDROCK_ENABLED=true`, Claude on Amazon Bedrock writes the note from pre-computed facts, never raw logs. Otherwise, or on any failure, a rule-based template writes it.

## How it uses Ring

Ring tells you when something happens. This app's job is noticing when something *doesn't*, so it combines several Ring sources into one picture:

| Ring source | Used for |
|---|---|
| **Event History** (camera `getEvents`, paginated) | On first connect, reads back 14 days so the routine baseline is ready on day one, not after three days. Afterwards, every 15 minutes as a backstop for missed live events |
| **Live events** (push notifications; webhooks on the partner path) | Doorbell presses and camera motion as they happen, including Ring's own `detection_type` ("loitering" counts as a visit) |
| **Ring Alarm sensors** (location websocket) | Door contacts (outings, answering the door, night doors) and motion sensors |
| **Snapshot** (`getSnapshot`, doorbell only) | One picture attached to an alert for context. Off until she turns it on from her own page; never an indoor camera; kept 30 days |
| **Device status** | Battery and connection health, so a dead sensor never looks like a quiet day |

## Alexa voice summary (optional)

A caregiver can ask "Alexa, ask home check-in how Mom is today" and hear the daily note, or ask how her week went and hear the digest. See [docs/alexa.md](docs/alexa.md). It's a standard custom skill endpoint, so it works on Alexa+ devices too. Every request's Amazon signature is verified, and it's off unless `ALEXA_SKILL_ID` is set.

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | public | `{ ok, mode, lastCheckAt }` for uptime monitors (`mode` is `demo`, `webcam`, `ring-account` or `ring-oauth`). Returns 503 if checks have stalled or no sensor is reporting |
| `POST /api/webhooks/ring` | HMAC | Ring event notifications, signed with `X-Ring-Signature: sha256=<hex>` |
| `GET /api/summary[?date=]` | session or `Bearer CRON_SECRET` | Status, the day's facts, the note, open alerts. Also runs the check |
| `GET /api/events?hours=24` | session | Recent events |
| `POST /api/events` | session, demo only | Simulate `{ deviceId, kind }` |
| `GET` / `POST /api/devices` | session | List devices / re-sync from Ring |
| `GET /api/auth/ring/login` | session | Start Ring OAuth (in demo mode, connects immediately) |
| `GET /r/:token` | signed link | Her one-tap check-in reply (and the neighbor's). Answers are POSTed by button, never on open |
| `GET /me/:key` | private key | Her own page: what's shared, pause, picture consent |
| `GET /api/snapshots/:file` | session | A doorbell picture attached to an alert |
| `POST /api/alexa` | Alexa signature | Voice summary skill (only when `ALEXA_SKILL_ID` is set) |

Signed webhook example:

```bash
BODY='{"event_id":"evt_1","event_type":"motion","device_id":"kitchen-motion"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$RING_WEBHOOK_SECRET" | sed 's/^.* //')
curl -X POST localhost:3000/api/webhooks/ring -H "X-Ring-Signature: sha256=$SIG" -H 'content-type: application/json' -d "$BODY"
```

## Configuration

Copy `.env.example` to `.env.local`. Every variable is described there.

Thresholds are edited on the Settings page and stored in the database: grace period, quiet and away hours, night window, reminder delay, baseline window, and per-device switches.

AWS setup (SNS topic and subscriptions, Bedrock model access, IAM) is covered in [docs/aws-integration.md](docs/aws-integration.md).

## Notes

- Data lives in `./data/ring-checkin.db`. Older databases are migrated automatically on startup. Delete the file to start over.
- Run the app as one long-lived Node process. The scheduler and the SQLite file need it.
- Node prints an `ExperimentalWarning` for SQLite on some versions. It is harmless.
- The partner-OAuth path ([lib/ring/oauth.ts](lib/ring/oauth.ts), [lib/ring/devices.ts](lib/ring/devices.ts)) is for official Ring API access. Its endpoint paths are configurable via env. Most setups use `npm run ring:login` instead ([lib/ring/account.ts](lib/ring/account.ts)).

## License

[MIT](LICENSE)
