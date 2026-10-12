import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { AlertRecord } from '../db';
import { nameForOthers, RULES, type CheckinSettings, type RuleId, type Severity } from '../routine/rules';
import { formatTime } from '../routine/time';

let sns: SNSClient | null = null;

/** Channel a message went out on: 'sns', 'log' (no AWS configured), or 'dashboard' (not pushed). */
export type NotifyChannel = 'sns' | 'log' | 'dashboard';

/**
 * Who a message is for. Family members subscribe to the SNS topic; the
 * resident and the neighbor are single people, texted directly.
 */
export type Audience = 'family' | 'resident' | 'neighbor';

export function isSnsConfigured(): boolean {
  return Boolean(process.env.SNS_TOPIC_ARN);
}

export function appUrl(): string {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function dashboardUrl(): string {
  return `${appUrl()}/dashboard`;
}

interface Message {
  subject: string;
  body: string;
  severity: Severity | 'resolved' | 'test' | 'digest' | 'notice';
  rule: string;
  audience?: Audience;
  /** Required for 'resident' and 'neighbor'. */
  phone?: string;
}

/**
 * Low-level publish. Family messages go to the topic (with `audience` and
 * `severity` attributes for subscription filter policies); resident and
 * neighbor messages are SMS straight to their number. Without SNS configured,
 * everything goes to the server log.
 */
async function publish(msg: Message): Promise<NotifyChannel> {
  const audience = msg.audience ?? 'family';
  const subject = `[Ring Check-in] ${msg.subject}`.replace(/[^\x20-\x7e]/g, '').slice(0, 100);
  const topicArn = process.env.SNS_TOPIC_ARN;
  if (!topicArn) {
    const to = audience === 'family' ? 'family' : `${audience} ${msg.phone ?? '(no number)'}`;
    console.log(`[notify] ${msg.severity.toUpperCase()} to ${to}: ${subject}\n${msg.body}`);
    return 'log';
  }
  sns ??= new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });
  if (audience !== 'family') {
    if (!msg.phone) throw new Error(`no phone number for ${audience}`);
    await sns.send(
      new PublishCommand({
        PhoneNumber: msg.phone,
        Message: msg.body,
        MessageAttributes: {
          'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
        },
      }),
    );
    return 'sns';
  }
  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: subject,
      Message: msg.body,
      MessageAttributes: {
        severity: { DataType: 'String', StringValue: msg.severity },
        rule: { DataType: 'String', StringValue: msg.rule },
        audience: { DataType: 'String', StringValue: audience },
      },
    }),
  );
  return 'sns';
}

/** Whether alerts of this severity are pushed to anyone (info stays on the dashboard). */
export const pushes = (severity: Severity) => severity !== 'info';

/** First rung of the ladder: a gentle, unalarming text to the resident themself. */
export async function sendResidentCheckIn(alert: AlertRecord, settings: CheckinSettings, replyUrl: string): Promise<NotifyChannel> {
  const name = settings.residentName;
  const what =
    alert.rule === 'no_morning_activity'
      ? 'we haven’t noticed you up and about yet this morning'
      : alert.rule === 'long_absence'
        ? 'you’ve been out a bit longer than usual'
        : 'it’s been quiet at home for a while';
  return publish({
    subject: 'Just checking in',
    body:
      `Hi ${name}, it's your family's check-in. ${what.charAt(0).toUpperCase()}${what.slice(1)}. ` +
      `Tap to let us know you're OK: ${replyUrl}\n` +
      `If we don't hear back in ${settings.caregiverAfterMinutes} minutes, we'll let your family know.`,
    severity: alert.severity,
    rule: alert.rule,
    audience: 'resident',
    phone: settings.residentPhone,
  });
}

/**
 * Second rung: family. Warnings and critical alerts go to the SNS topic
 * (SMS/email subscribers); info-level ones only show on the dashboard.
 */
export async function sendAlertNotification(alert: AlertRecord, settings: CheckinSettings): Promise<NotifyChannel> {
  if (!pushes(alert.severity)) return 'dashboard';
  const tz = settings.timezone;
  const lines = [alert.message, ''];
  if (alert.residentAt != null) {
    lines.push(`${settings.residentName} didn’t reply to a check-in text sent at ${formatTime(alert.residentAt, tz)}.`);
  }
  if (settings.neighborPhone && alert.neighborAt == null && RULES[alert.rule].asksNeighbor) {
    const neighbor = settings.neighborName || 'the neighbor';
    const at = alert.createdAt + settings.neighborAfterMinutes * 60_000;
    lines.push(`If nobody marks this as checked by ${formatTime(at, tz)}, ${neighbor} will be asked to knock.`);
  }
  lines.push(`Detected at ${formatTime(alert.createdAt, tz)}. Open the dashboard: ${dashboardUrl()}`);
  return publish({ subject: alert.title, body: lines.join('\n'), severity: alert.severity, rule: alert.rule });
}

/**
 * The resident tapped "Please call me", or the neighbor "I couldn't reach them".
 * Always goes to family, at once.
 */
export async function sendHelpRequest(
  alert: AlertRecord,
  settings: CheckinSettings,
  now: number,
  from: 'resident' | 'neighbor' = 'resident',
): Promise<NotifyChannel> {
  const name = settings.residentName;
  const at = formatTime(now, settings.timezone);
  const neighbor = settings.neighborName || 'The neighbor';
  return publish({
    subject: from === 'resident' ? `${name} asked for a call` : `${neighbor} couldn't reach ${name}`,
    body: [
      from === 'resident'
        ? `${name} tapped “Please call me” on a check-in text at ${at}.`
        : `${neighbor} went to check on ${name} and couldn't reach them (${at}).`,
      `The check-in was about: ${alert.title}.`,
      '',
      `Mark it as checked once you've spoken: ${dashboardUrl()}`,
    ].join('\n'),
    severity: 'critical',
    rule: alert.rule,
  });
}

/** What happened, phrased for someone outside the family. */
export function situationForNeighbor(rule: RuleId, name: string): string {
  if (rule === 'no_morning_activity') return `there's been no sign of ${name} up and about this morning`;
  if (rule === 'prolonged_inactivity') return `it's been unusually quiet at ${name}'s home for a while`;
  return `something looks unusual at ${name}'s home today`;
}

/** Last rung: someone nearby who can knock on the door. */
export async function sendNeighborRequest(alert: AlertRecord, settings: CheckinSettings, replyUrl: string): Promise<NotifyChannel> {
  const name = nameForOthers(settings);
  const what = situationForNeighbor(alert.rule, name);
  return publish({
    subject: `Could you check on ${name}?`,
    body:
      `Hi${settings.neighborName ? ` ${settings.neighborName}` : ''}, this is ${name}'s family check-in. ` +
      `${what.charAt(0).toUpperCase()}${what.slice(1)}, and the family hasn't been able to confirm ${name} is OK. ` +
      `Could you knock on the door? Tap here once you've checked: ${replyUrl}`,
    severity: alert.severity,
    rule: alert.rule,
    audience: 'neighbor',
    phone: settings.neighborPhone,
  });
}

/** Follow-up when a pushed alert clears by itself, so nobody keeps worrying. */
export async function sendResolvedNotification(alert: AlertRecord, settings: CheckinSettings): Promise<NotifyChannel> {
  if (!pushes(alert.severity) || alert.acknowledgedAt != null) return 'dashboard';
  return publish({
    subject: `All clear: ${alert.resolutionNote ?? alert.title}`,
    body: [
      `${alert.resolutionNote ?? 'The situation has cleared.'}`,
      '',
      `Earlier alert (${formatTime(alert.createdAt, settings.timezone)}): ${alert.title}`,
      dashboardUrl(),
    ].join('\n'),
    severity: 'resolved',
    rule: alert.rule,
  });
}

/** Tells a neighbor who was asked to knock that they no longer need to. */
export async function sendNeighborStandDown(alert: AlertRecord, settings: CheckinSettings): Promise<NotifyChannel> {
  return publish({
    subject: 'No need to check',
    body: `Thanks${settings.neighborName ? `, ${settings.neighborName}` : ''}. No need to check on ${nameForOthers(settings)} any more: the family knows all is well.`,
    severity: 'resolved',
    rule: alert.rule,
    audience: 'neighbor',
    phone: settings.neighborPhone,
  });
}

/** Second nudge when an urgent alert sits unacknowledged. */
export async function sendReminder(alert: AlertRecord, settings: CheckinSettings): Promise<NotifyChannel> {
  return publish({
    subject: `Still unanswered: ${alert.title}`,
    body: [
      `Nobody has marked this alert as checked yet. ${alert.message}`,
      '',
      `First sent at ${formatTime(alert.caregiverAt ?? alert.createdAt, settings.timezone)}. Open the dashboard to acknowledge it: ${dashboardUrl()}`,
    ].join('\n'),
    severity: alert.severity,
    rule: alert.rule,
  });
}

/** The resident paused sharing from their own page; family should know monitoring is off. */
export async function sendPrivacyPauseNotice(settings: CheckinSettings, until: number): Promise<NotifyChannel> {
  return publish({
    subject: `${settings.residentName} paused check-ins`,
    body:
      `${settings.residentName} paused sharing until ${formatTime(until, settings.timezone)}. ` +
      `Activity isn't recorded and no check-in alerts can fire until then.\n${dashboardUrl()}`,
    severity: 'notice',
    rule: 'privacy_pause',
  });
}

/** The weekly family digest, to everyone on the topic. */
export async function sendWeeklyDigest(subject: string, body: string): Promise<NotifyChannel> {
  return publish({ subject, body: `${body}\n\nThe full week: ${appUrl()}/dashboard/week`, severity: 'digest', rule: 'digest' });
}

export async function sendTestNotification(settings: CheckinSettings): Promise<NotifyChannel> {
  return publish({
    subject: 'Test alert',
    body: `This is a test from Ring Check-in for ${settings.residentName}. If you got this, alerts will reach you.\n${dashboardUrl()}`,
    severity: 'test',
    rule: 'test',
  });
}
