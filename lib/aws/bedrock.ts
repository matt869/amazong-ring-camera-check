import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { betaRefusalFallbackMiddleware } from '@anthropic-ai/sdk';

/** Everything the summary is allowed to say, pre-computed so the model never sees raw event logs. */
export interface DayFacts {
  residentName: string;
  dateLabel: string;
  nowLabel: string;
  isToday: boolean;
  firstActivity: string | null;
  usualFirstActivity: string | null;
  lastActivity: string | null;
  activityCount: number;
  usualActivityByNow: number | null;
  rooms: { location: string; count: number }[];
  outings: { left: string; returned: string | null }[];
  visitors: number;
  /** Doorbell visits: when, what kind (expected, regular, likely delivery, unexpected), and whether a door opened. */
  visits: { time: string; kind: string; doorOpened: boolean | null }[];
  /** The day's alerts: whether each still needs attention, and how it was resolved. */
  alerts: { rule: string; title: string; severity: string; open: boolean; resolution: string | null }[];
  /** Set while alerts are paused (e.g. they're staying with family). */
  pausedUntil: string | null;
  /** The resident paused sharing themself, from their own page. */
  pausedByResident: boolean;
}

export interface DaySummary {
  text: string;
  source: 'bedrock' | 'template';
}

export function isBedrockEnabled(): boolean {
  return process.env.BEDROCK_ENABLED === 'true';
}

let client: AnthropicBedrockMantle | null = null;

function getClient(): AnthropicBedrockMantle {
  client ??= new AnthropicBedrockMantle({
    awsRegion: process.env.AWS_REGION || 'us-east-1',
    // If the primary model declines, retry on the previous Opus rather than showing nothing.
    middleware: [betaRefusalFallbackMiddleware([{ model: 'anthropic.claude-opus-4-8' }])],
  });
  return client;
}

const SYSTEM_PROMPT = `You write the daily check-in note that family caregivers read about a relative who lives alone. The note is based only on activity from home sensors (motion, doors, doorbell), so you know when and where there was movement, not what the person was doing or how they feel.

Write 2-4 plain sentences, warm but factual, like a neighbor who keeps an eye out. Lead with whether the day looks normal compared with their usual routine. Mention anything unusual from the alerts and say plainly whether it still needs attention or has since cleared (open: false). Mention doorbell visits only if one was unexpected. If alerts are paused, say so in a few words (pausedByResident means they chose to pause sharing themselves; say that respectfully). Do not guess at health, mood, or causes, and do not give medical advice. Use the times exactly as given. No headings, lists, or emoji.`;

/**
 * Asks Claude on Bedrock to write from pre-computed facts. Returns null when
 * Bedrock is off, declines, or fails, so callers fall back to their template.
 */
export async function writeWithClaude(system: string, label: string, facts: unknown): Promise<string | null> {
  if (!isBedrockEnabled()) return null;
  try {
    const response = await getClient().beta.messages.create({
      model: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-opus-5-5',
      max_tokens: 16000,
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: `${label}, as JSON:\n${JSON.stringify(facts, null, 2)}` }],
    });
    if (response.stop_reason === 'refusal') {
      console.warn(`[bedrock] ${label} declined; using template`);
      return null;
    }
    const text = response.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('')
      .trim();
    return text || null;
  } catch (err) {
    console.error(`[bedrock] ${label} failed; using template:`, (err as Error).message);
    return null;
  }
}

export async function summarizeDay(facts: DayFacts): Promise<DaySummary> {
  const text = await writeWithClaude(SYSTEM_PROMPT, 'Activity facts for the note', facts);
  return text ? { text, source: 'bedrock' } : { text: templateSummary(facts), source: 'template' };
}

/** Deterministic summary used without Bedrock, and as the fallback when it fails. */
export function templateSummary(f: DayFacts): string {
  const name = f.residentName;
  const parts: string[] = [];

  if (!f.firstActivity) {
    if (!f.isToday) parts.push(`No activity was recorded for ${name}.`);
    else if (f.usualFirstActivity) parts.push(`No movement at home yet today; ${name} is usually up around ${f.usualFirstActivity}.`);
    else parts.push(`No movement at home yet today.`);
  } else {
    let wake = `${name} was first up at ${f.firstActivity}`;
    if (f.usualFirstActivity) wake += ` (usually around ${f.usualFirstActivity})`;
    parts.push(`${wake}.`);

    const busiest = f.rooms.slice(0, 2).map((r) => r.location.toLowerCase());
    let activity = `${f.activityCount} ${f.activityCount === 1 ? 'movement' : 'movements'} recorded${f.isToday ? ' so far' : ''}`;
    if (busiest.length) activity += `, mostly in the ${busiest.join(' and ')}`;
    // Too early in the day, small numbers make the comparison noise.
    if (f.usualActivityByNow != null && f.usualActivityByNow >= 8 && f.isToday) {
      const ratio = f.activityCount / Math.max(1, f.usualActivityByNow);
      if (ratio < 0.5) activity += ` — noticeably less than usual by this time`;
      else if (ratio > 1.6) activity += ` — busier than usual`;
    }
    parts.push(`${activity}.`);

    const outing = f.outings[f.outings.length - 1];
    if (outing) {
      parts.push(outing.returned ? `Went out at ${outing.left} and was back by ${outing.returned}.` : `Went out at ${outing.left} and hasn't come back in yet.`);
    }
    if (f.lastActivity && f.isToday && (!outing || outing.returned)) parts.push(`Last movement at ${f.lastActivity}.`);
  }

  // Lowercase only the first letter so names inside titles keep their capitals.
  const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const notable = f.alerts.filter((a) => a.severity !== 'info');
  // The opening sentence already covers a missed morning; don't repeat it.
  const open = notable.filter((a) => a.open && !(a.rule === 'no_morning_activity' && !f.firstActivity));
  const cleared = notable.filter((a) => !a.open && a.resolution);
  if (open.length) parts.push(`Needs a look: ${open.map((a) => lcFirst(a.title)).join('; ')}.`);
  if (cleared.length) parts.push(`Earlier alert “${cleared[0].title}” has cleared: ${cleared[0].resolution}`);
  const unexpected = (f.visits ?? []).filter((v) => v.kind.startsWith('Unexpected'));
  if (unexpected.length) {
    const opened = unexpected.some((v) => v.doorOpened);
    parts.push(`An unexpected visitor rang at ${unexpected.map((v) => v.time).join(' and ')}${opened ? ' and the door was opened' : ''}.`);
  }
  if (!open.length && !cleared.length && !unexpected.length && f.firstActivity) parts.push('Nothing unusual to flag.');
  if (f.pausedUntil) {
    parts.push(f.pausedByResident ? `${name} has paused sharing until ${f.pausedUntil}.` : `Alerts are paused until ${f.pausedUntil}.`);
  }

  return parts.join(' ');
}
