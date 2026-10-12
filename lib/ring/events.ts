import { addFamilyLog, getKv, insertEvents, listDevices, setKv, upsertDevices } from '../db';
import { daysBetween, localParts } from '../routine/time';
import { ringRequest } from './client';
import { DEMO_DAYS, generateDemoEvents, generateDemoFamilyLog, MOCK_DEVICES, type DemoScenario } from './mock';
import { isMockMode } from './oauth';
import { normalizeKind } from './webhooks';
import type { RingEvent } from './types';

interface RingHistoryItem {
  id: number | string;
  kind?: string;
  created_at?: string;
}

/** Pulls recent history for every known device from Ring (used after connecting and as a webhook backstop). */
export async function fetchRecentEvents(limitPerDevice = 50): Promise<RingEvent[]> {
  const events: RingEvent[] = [];
  for (const device of listDevices()) {
    const path =
      device.kind === 'doorbell' || device.kind === 'camera'
        ? `/clients_api/doorbots/${device.id}/history?limit=${limitPerDevice}`
        : `/clients_api/devices/${device.id}/history?limit=${limitPerDevice}`;
    let items: RingHistoryItem[];
    try {
      items = await ringRequest<RingHistoryItem[]>(path);
    } catch (err) {
      console.warn(`[ring] history unavailable for ${device.name}:`, (err as Error).message);
      continue;
    }
    for (const item of items) {
      const kind = normalizeKind(item.kind);
      const occurredAt = item.created_at ? Date.parse(item.created_at) : NaN;
      if (!kind || Number.isNaN(occurredAt)) continue;
      events.push({ id: String(item.id), deviceId: device.id, kind, occurredAt, payload: { source: 'history' } });
    }
  }
  return events;
}

interface DemoState {
  scenario: DemoScenario;
  /** When it was applied (anchors time-relative scenarios). */
  anchor: number;
}

function getDemoState(): DemoState {
  const raw = getKv<DemoState | DemoScenario>('demo_scenario');
  if (raw == null) return { scenario: 'normal', anchor: 0 };
  return typeof raw === 'string' ? { scenario: raw, anchor: 0 } : raw;
}

export function getDemoScenario(): DemoScenario {
  return getDemoState().scenario;
}

export function setDemoScenario(scenario: DemoScenario, anchor = Date.now()): void {
  setKv('demo_scenario', { scenario, anchor } satisfies DemoState);
}

interface DemoFill {
  scenario: DemoScenario;
  anchor: number;
  timezone: string;
  /** Last local date fully generated. */
  through: string;
}

/**
 * In demo mode, makes sure devices exist and the simulated routine is filled
 * in up to `now`, so the dashboard behaves like a live feed. Idempotent; after
 * the first fill it only regenerates the days since the last one.
 */
export function ensureDemoData(now: number, timezone: string, days = DEMO_DAYS): number {
  if (!isMockMode()) return 0;
  const known = new Set(listDevices().map((d) => d.id));
  const missing = MOCK_DEVICES.filter((d) => !known.has(d.id));
  if (missing.length) upsertDevices(missing);
  const { scenario, anchor } = getDemoState();
  const today = localParts(now, timezone).dateKey;
  const fill = getKv<DemoFill>('demo_fill');
  const sameRun = fill && fill.scenario === scenario && fill.anchor === anchor && fill.timezone === timezone;
  const span = sameRun ? Math.min(days, Math.max(1, daysBetween(fill.through, today) + 1)) : days;

  const inserted = insertEvents(generateDemoEvents({ now, timezone, days: span, scenario, anchor })).length;
  for (const entry of generateDemoFamilyLog({ now, timezone, days: span })) addFamilyLog(entry);
  setKv('demo_fill', { scenario, anchor, timezone, through: today } satisfies DemoFill);
  return inserted;
}
