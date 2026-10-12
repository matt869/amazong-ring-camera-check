import Link from 'next/link';
import PauseControl from '@/components/PauseControl';
import { isBedrockEnabled } from '@/lib/aws/bedrock';
import { isSnsConfigured } from '@/lib/aws/notify';
import { getSettings, listDevices } from '@/lib/db';
import { DEMO_SCENARIOS } from '@/lib/ring/mock';
import { getDemoScenario } from '@/lib/ring/events';
import { getRingAccountStatus } from '@/lib/ring/account';
import { isMockMode, usesRingAccount } from '@/lib/ring/oauth';
import QRCode from 'qrcode';
import { appBaseUrl } from '@/app/setup/links';
import { hasResidentLink, pendingResidentKey } from '@/lib/resident';
import { RULES, type RuleId } from '@/lib/routine/rules';
import { localParts, WEEKDAYS } from '@/lib/routine/time';
import { snapshotsSupported } from '@/lib/snapshot';
import {
  createResidentLinkAction,
  pauseAction,
  resumeAction,
  saveSettingsAction,
  sendTestAlertAction,
  setDemoScenarioAction,
} from '../actions';

export const dynamic = 'force-dynamic';

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const NOTICES: Record<string, { text: string; error?: boolean }> = {
  saved: { text: 'Settings saved.' },
  'test-sns': { text: 'Test alert published to your SNS topic. Subscribers should get it within a minute.' },
  'test-log': { text: 'SNS isn’t configured, so the test alert was written to the server log instead.' },
  'test-failed': { text: 'Sending the test alert failed. Check the server log for the AWS error.', error: true },
  'bad-timezone': { text: 'That timezone wasn’t recognized. Use an IANA name like America/Chicago.', error: true },
  'bad-pause': { text: 'Pick a date in the future to pause until.', error: true },
  'bad-phone': { text: 'Phone numbers need the country code, like +15551234567.', error: true },
  'bad-visits': { text: 'One of the expected visits wasn’t understood. Use the form “Home aide: Tue Thu 9:30-11:00”.', error: true },
  'resident-link': { text: 'New link created. The old one, if any, no longer works.' },
  'resident-paused': { text: 'The resident paused sharing from their own page, so only they can end it early.', error: true },
};

function ringStatusText(): string {
  if (!usesRingAccount()) return process.env.RING_CLIENT_ID ? 'Connected via partner OAuth' : 'Not used (optional)';
  const s = getRingAccountStatus();
  if (s.state === 'connected') return `Connected: ${s.cameras} camera(s), ${s.sensors} alarm sensor(s)`;
  if (s.state === 'error') return `Can't connect: ${s.error ?? 'unknown error'}`;
  return 'Connecting…';
}

export default async function Settings({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  const s = getSettings();
  const devices = listDevices();
  const webcams = devices.filter((d) => d.kind === 'webcam');
  const mock = isMockMode();
  const banner = notice ? NOTICES[notice] : undefined;
  const residentKey = pendingResidentKey();
  const residentUrl = residentKey ? `${await appBaseUrl()}/me/${residentKey}` : null;
  const residentQr = residentUrl ? await QRCode.toString(residentUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : null;

  return (
    <div className="stack">
      <h1>Settings</h1>
      {banner && (
        <p className={`notice${banner.error ? ' error' : ''}`} role="status">
          {banner.text}
        </p>
      )}

      <PauseControl
        pausedUntil={s.pausedUntil}
        pausedBy={s.pausedBy}
        residentName={s.residentName}
        timezone={s.timezone}
        today={localParts(Date.now(), s.timezone).dateKey}
        back="/dashboard/settings"
        pause={pauseAction}
        resume={resumeAction}
      />

      <nav className="jump" aria-label="Settings sections">
        <a href="#rules">Alert rules</a>
        <a href="#ladder">If a day looks different</a>
        <a href="#digest">Weekly digest</a>
        <a href="#visitors">Visitors</a>
        <a href="#devices">Devices</a>
        <a href="#resident">{s.residentName}&apos;s page</a>
      </nav>

      <form action={saveSettingsAction} className="card form">
        <div className="grid-2">
          <div className="field">
            <label htmlFor="residentName">Who are you checking in on?</label>
            <input id="residentName" name="residentName" defaultValue={s.residentName} required maxLength={60} />
          </div>
          <div className="field">
            <label htmlFor="timezone">Their timezone</label>
            <input id="timezone" name="timezone" defaultValue={s.timezone} placeholder="America/New_York" />
            <span className="hint">IANA name, e.g. America/Chicago or Europe/London.</span>
          </div>
        </div>

        <fieldset id="rules">
          <legend>Alert rules</legend>
          {(Object.keys(RULES) as RuleId[]).map((id) => (
            <label key={id} className="checkbox">
              <input type="checkbox" name={`rule_${id}`} defaultChecked={s.enabledRules[id]} />
              <span>
                <strong>{RULES[id].label}</strong>{' '}
                <span className={`sev sev-${RULES[id].severity}`}>{RULES[id].severity === 'info' ? 'dashboard only' : RULES[id].severity === 'critical' ? 'urgent' : 'notify'}</span>
                <br />
                <span className="muted">{RULES[id].description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>Thresholds</legend>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="wakeGraceMinutes">Morning grace period (minutes)</label>
              <input id="wakeGraceMinutes" name="wakeGraceMinutes" type="number" min={15} max={360} defaultValue={s.wakeGraceMinutes} />
              <span className="hint">Wait this long past their usual wake-up before alerting. Mornings that normally vary get extra slack automatically.</span>
            </div>
            <div className="field">
              <label htmlFor="fallbackWake">Latest normal wake-up</label>
              <input id="fallbackWake" name="fallbackWake" type="time" defaultValue={hhmm(s.fallbackWakeMinute)} />
              <span className="hint">Used for the first few days, until their routine is learned.</span>
            </div>
            <div className="field">
              <label htmlFor="inactivityHours">Quiet at home for (hours)</label>
              <input id="inactivityHours" name="inactivityHours" type="number" min={1} max={12} step={0.5} defaultValue={s.inactivityHours} />
              <span className="hint">Only during hours that are normally active for them.</span>
            </div>
            <div className="field">
              <label htmlFor="awayHours">Out of the house for (hours)</label>
              <input id="awayHours" name="awayHours" type="number" min={1} max={24} step={0.5} defaultValue={s.awayHours} />
              <span className="hint">Also alerts if they’re still out when night starts.</span>
            </div>
            <div className="field">
              <label htmlFor="nightStart">Night starts</label>
              <input id="nightStart" name="nightStart" type="time" defaultValue={hhmm(s.nightStartMinute)} />
            </div>
            <div className="field">
              <label htmlFor="nightEnd">Night ends</label>
              <input id="nightEnd" name="nightEnd" type="time" defaultValue={hhmm(s.nightEndMinute)} />
            </div>
            <div className="field">
              <label htmlFor="reminderMinutes">Remind if an urgent alert isn’t answered in (minutes)</label>
              <input id="reminderMinutes" name="reminderMinutes" type="number" min={0} max={240} defaultValue={s.reminderMinutes} />
              <span className="hint">0 turns reminders off.</span>
            </div>
            <div className="field">
              <label htmlFor="lowBatteryPercent">Low battery at (%)</label>
              <input id="lowBatteryPercent" name="lowBatteryPercent" type="number" min={5} max={50} defaultValue={s.lowBatteryPercent} />
            </div>
            <div className="field">
              <label htmlFor="baselineDays">Days of history to learn from</label>
              <input id="baselineDays" name="baselineDays" type="number" min={3} max={60} defaultValue={s.baselineDays} />
            </div>
          </div>
        </fieldset>

        <fieldset id="ladder">
          <legend>If a day looks different</legend>
          <p className="hint" style={{ margin: 0 }}>
            A gentle ladder instead of an alarm: {s.residentName} gets a friendly text first, family is told if there&apos;s
            no reply, and a neighbor is asked to knock if nobody can check. It stops the moment {s.residentName} taps
            &ldquo;I&apos;m OK&rdquo;, moves around again, or someone marks the alert as checked. A door opening at night goes
            straight to family.
          </p>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="residentPhone">{s.residentName}&apos;s mobile number</label>
              <input id="residentPhone" name="residentPhone" type="tel" defaultValue={s.residentPhone} placeholder="+15551234567" />
              <span className="hint">With the country code. Leave empty to tell family straight away.</span>
            </div>
            <label className="checkbox" style={{ alignSelf: 'center' }}>
              <input type="checkbox" name="checkInFirst" defaultChecked={s.checkInFirst} />
              <span>Text {s.residentName} first, before family</span>
            </label>
            <div className="field">
              <label htmlFor="caregiverAfterMinutes">Tell family if no reply after (minutes)</label>
              <input id="caregiverAfterMinutes" name="caregiverAfterMinutes" type="number" min={5} max={120} defaultValue={s.caregiverAfterMinutes} />
            </div>
            <div className="field">
              <label htmlFor="neighborAfterMinutes">Ask the neighbor after (minutes from the start)</label>
              <input id="neighborAfterMinutes" name="neighborAfterMinutes" type="number" min={10} max={240} defaultValue={s.neighborAfterMinutes} />
              <span className="hint">Only if nobody in the family has marked it as checked.</span>
            </div>
            <div className="field">
              <label htmlFor="neighborName">Neighbor&apos;s name</label>
              <input id="neighborName" name="neighborName" defaultValue={s.neighborName} maxLength={40} placeholder="e.g. Ruth next door" />
            </div>
            <div className="field">
              <label htmlFor="residentGivenName">What the neighbor calls {s.residentName}</label>
              <input id="residentGivenName" name="residentGivenName" defaultValue={s.residentGivenName} maxLength={40} placeholder="e.g. Ana" />
              <span className="hint">Used in messages to the neighbor, who won&apos;t know them as &ldquo;{s.residentName}&rdquo;.</span>
            </div>
            <div className="field">
              <label htmlFor="neighborPhone">Neighbor&apos;s mobile number</label>
              <input id="neighborPhone" name="neighborPhone" type="tel" defaultValue={s.neighborPhone} placeholder="+15557654321" />
              <span className="hint">Empty means no neighbor step. Ask them first.</span>
            </div>
          </div>
        </fieldset>

        <fieldset id="digest">
          <legend>Weekly family digest</legend>
          <label className="checkbox">
            <input type="checkbox" name="digestEnabled" defaultChecked={s.digestEnabled} />
            <span>
              Send everyone on the alert topic a short summary of the week: routine, who checked in, alerts, visitors and
              slow changes. <Link href="/dashboard/week">See this week&apos;s</Link>.
            </span>
          </label>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="digestWeekday">Day</label>
              <select id="digestWeekday" name="digestWeekday" defaultValue={s.digestWeekday}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="digestTime">Time</label>
              <input id="digestTime" name="digestTime" type="time" defaultValue={hhmm(s.digestMinute)} />
            </div>
          </div>
        </fieldset>

        <fieldset id="visitors">
          <legend>Expected visitors</legend>
          <div className="field">
            <label htmlFor="expectedVisits">Who comes to the door, and when (one per line)</label>
            <textarea
              id="expectedVisits"
              name="expectedVisits"
              rows={3}
              defaultValue={s.expectedVisits}
              placeholder={'Home aide: Tue Thu 9:30-11:00\nMeals on Wheels: weekdays 11:30am-12:30pm'}
            />
            <span className="hint">
              Doorbell visits that match are marked expected. Visits that recur at the same time each week are learned
              automatically. Several unexpected callers in a week raise an alert, since repeat visits are a common pattern
              in scams targeting older adults.
            </span>
          </div>
        </fieldset>

        <fieldset id="devices">
          <legend>Devices</legend>
          <p className="hint" style={{ margin: 0 }}>
            Choose which devices show that they’re up and about. Doorbell motion is off by default because it mostly sees
            delivery drivers and passers-by.
          </p>
          {devices.length === 0 && <p className="muted">No devices synced yet.</p>}
          {devices.map((d) => (
            <label key={d.id} className="checkbox">
              <input type="checkbox" name={`device_${d.id}`} defaultChecked={d.countsAsActivity} />
              <span>
                <strong>{d.name}</strong> <span className="muted">· {d.location}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div>
          <button className="button" type="submit">
            Save settings
          </button>
        </div>
      </form>

      <section className="card stack">
        <h2>Integrations</h2>
        <ul className="devices">
          <li>
            <span>
              Webcams · <Link href="/setup">set up</Link>
            </span>
            <span className="subtle">
              {mock
                ? 'None yet: showing demo data'
                : `${webcams.filter((w) => w.online).length} of ${webcams.length} checking in`}
            </span>
          </li>
          <li>
            <span>Ring</span>
            <span className="subtle">{ringStatusText()}</span>
          </li>
          <li>
            <span>Alerts (Amazon SNS)</span>
            <span className="subtle">{isSnsConfigured() ? 'Publishing to topic' : 'Not configured: alerts are logged'}</span>
          </li>
          <li>
            <span>Doorbell pictures with alerts</span>
            <span className="subtle">
              {!snapshotsSupported()
                ? 'Needs a Ring account with a doorbell'
                : s.snapshotsAllowed
                  ? `On (${s.residentName} allowed it)`
                  : `Off: only ${s.residentName} can turn this on, from their page`}
            </span>
          </li>
          <li>
            <span>Alexa voice summary</span>
            <span className="subtle">{process.env.ALEXA_SKILL_ID ? 'On' : 'Off (optional, see docs/alexa.md)'}</span>
          </li>
          <li>
            <span>Daily note and weekly digest (Amazon Bedrock)</span>
            <span className="subtle">{isBedrockEnabled() ? process.env.BEDROCK_MODEL_ID || 'anthropic.claude-opus-5-5' : 'Off: using template'}</span>
          </li>
        </ul>
        <form action={sendTestAlertAction}>
          <button className="button secondary" type="submit">
            Send a test alert
          </button>
        </form>
      </section>

      <section className="card stack" id="resident">
        <h2>{s.residentName}&apos;s own page</h2>
        <p className="muted" style={{ margin: 0, maxWidth: '68ch' }}>
          A private page for {s.residentName}, in plain language: exactly what&apos;s shared and with whom, what happens
          when a day looks different, and a button to pause sharing (nothing is recorded while paused; you&apos;ll see that
          it&apos;s paused). Doorbell pictures can only be turned on there, by {s.residentName}.
        </p>
        {residentUrl && residentQr ? (
          <div className="link-box">
            <div className="qr" dangerouslySetInnerHTML={{ __html: residentQr }} aria-label="QR code for the resident's page" role="img" />
            <div className="stack" style={{ gap: 8 }}>
              <strong>Open this on {s.residentName}&apos;s phone or tablet and bookmark it</strong>
              <input className="link-input" readOnly value={residentUrl} aria-label="Resident page link" />
              <span className="hint">Shown here for an hour. Anyone with the link can see the page, so give it only to {s.residentName}.</span>
            </div>
          </div>
        ) : null}
        <form action={createResidentLinkAction}>
          <button className="button secondary" type="submit">
            {hasResidentLink() ? 'Make a new link (turns off the old one)' : `Create ${s.residentName}'s link`}
          </button>
        </form>
      </section>

      {mock && (
        <form action={setDemoScenarioAction} className="card form">
          <h2>Demo scenario</h2>
          <p className="muted" style={{ margin: 0 }}>
            Replaces today&apos;s simulated activity so you can see how each alert looks. The last two scenarios also reshape
            the past weeks, for the Trends and visitor views.
          </p>
          <div className="field">
            <label htmlFor="scenario">Today</label>
            <select id="scenario" name="scenario" defaultValue={getDemoScenario()}>
              {Object.entries(DEMO_SCENARIOS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <button className="button secondary" type="submit">
              Apply scenario
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
