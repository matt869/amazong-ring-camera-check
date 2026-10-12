import type { Metadata } from 'next';
import { getAlert, getSettings } from '@/lib/db';
import { readReplyToken } from '@/lib/escalation';
import { situationForNeighbor } from '@/lib/aws/notify';
import { nameForOthers, type RuleId } from '@/lib/routine/rules';
import { formatTime } from '@/lib/routine/time';
import { replyAction } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Checking in' };

const SITUATION: Partial<Record<RuleId, string>> = {
  no_morning_activity: "We haven't noticed you up and about yet this morning.",
  prolonged_inactivity: "It's been quiet at home for a while.",
  long_absence: "You've been out a bit longer than usual.",
};

/**
 * The page behind the check-in text. Opening it changes nothing (phones
 * preview links automatically); only pressing a button sends an answer.
 */
export default async function ReplyPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { token } = await params;
  const { done } = await searchParams;
  const link = readReplyToken(token);
  const alert = link ? getAlert(link.alertId) : null;
  const settings = getSettings();
  const name = settings.residentName;

  if (!link || !alert) {
    return (
      <div className="resident-page">
        <section className="card stack">
          <h1>This link has expired</h1>
          <p className="resident-lead">Check-in links work for a day. If you need anything, please call your family.</p>
        </section>
      </div>
    );
  }

  const neighbor = link.role === 'neighbor';
  // The neighbor knows them as "Ana", not "Mom".
  const theirName = neighbor ? nameForOthers(settings) : name;
  const familyAt = alert.residentAt != null ? formatTime(alert.residentAt + settings.caregiverAfterMinutes * 60_000, settings.timezone) : null;
  const answered =
    done === 'ok' ||
    done === 'help' ||
    (neighbor ? alert.reply === 'neighbor-ok' || alert.neighborHelpAt != null : alert.reply === 'ok' || alert.reply === 'help');
  const said = done ?? ((neighbor ? alert.neighborHelpAt != null : alert.reply === 'help') ? 'help' : 'ok');

  if (answered) {
    return (
      <div className="resident-page">
        <section className="card stack">
          <h1>{said === 'help' ? (neighbor ? 'Thank you. The family has been told.' : 'Your family has been told.') : 'Thank you'}</h1>
          <p className="resident-lead">
            {said === 'help'
              ? neighbor
                ? `${theirName}'s family knows you couldn't reach them and will take it from here.`
                : 'Someone from your family will call you soon. If it’s an emergency, call 911.'
              : neighbor
                ? `${theirName}'s family knows you checked. Thank you for looking in.`
                : 'We’ve let your family know you’re OK. Have a good day.'}
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="resident-page">
      <form action={replyAction} className="card stack">
        <input type="hidden" name="token" value={token} />
        {neighbor ? (
          <>
            <h1>Could you check on {theirName}?</h1>
            <p className="resident-lead">
              {theirName}&apos;s family is asking for help: {situationForNeighbor(alert.rule, theirName)} (since{' '}
              {formatTime(alert.createdAt, settings.timezone)}), and they haven&apos;t been able to confirm {theirName} is OK.
              Please knock on the door, then tap below.
            </p>
            <button className="button big" type="submit" name="answer" value="ok">
              {theirName} is OK
            </button>
            <button className="button big secondary" type="submit" name="answer" value="help">
              I couldn&apos;t reach {theirName}
            </button>
            <p className="subtle">If someone needs urgent help, call 911 first.</p>
          </>
        ) : (
          <>
            <h1>Hi {name}, just checking in</h1>
            <p className="resident-lead">
              {SITUATION[alert.rule] ?? 'Today looks a little different from usual.'} Are you OK?
            </p>
            <button className="button big" type="submit" name="answer" value="ok">
              I&apos;m OK
            </button>
            <button className="button big secondary" type="submit" name="answer" value="help">
              Please call me
            </button>
            <p className="subtle">
              Nothing is sent until you tap a button.{' '}
              {alert.caregiverAt == null && familyAt
                ? `If we don't hear back by ${familyAt}, we'll let your family know.`
                : 'Your family has been told and may call you.'}
            </p>
          </>
        )}
      </form>
    </div>
  );
}
