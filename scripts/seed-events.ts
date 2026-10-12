/**
 * Seeds the local database with a simulated household and its routine.
 *
 *   npm run seed                         # 9 weeks of normal routine
 *   npm run seed -- --scenario quiet-morning
 *   npm run seed -- --days 30 --scenario night-door
 *
 * Most scenarios only change today; gradual-decline and repeat-visitor reshape
 * the past weeks too. See DEMO_SCENARIOS in lib/ring/mock.ts.
 */
import { countEvents, getSettings, insertEvents, resetDemoData, upsertDevices } from '../lib/db';
import { runCheck } from '../lib/checkin';
import { DEMO_DAYS, DEMO_SCENARIOS, generateDemoEvents, MOCK_DEVICES, type DemoScenario } from '../lib/ring/mock';
import { setDemoScenario } from '../lib/ring/events';
import { isMockMode } from '../lib/ring/oauth';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const scenario = (arg('scenario') ?? 'normal') as DemoScenario;
  if (!(scenario in DEMO_SCENARIOS)) {
    console.error(`Unknown scenario "${scenario}". Choose one of: ${Object.keys(DEMO_SCENARIOS).join(', ')}`);
    process.exit(1);
  }
  const days = Math.max(1, Number(arg('days') ?? DEMO_DAYS));
  const now = Date.now();
  const { timezone } = getSettings();

  // With a real Ring account connected, keep its events and only replace simulated ones.
  resetDemoData(isMockMode());
  upsertDevices(MOCK_DEVICES);
  setDemoScenario(scenario, now);
  const inserted = insertEvents(generateDemoEvents({ now, timezone, days, scenario, anchor: now }));
  const { created } = await runCheck(now);

  console.log(`Seeded ${inserted.length} events over ${days} days (${timezone}), scenario: ${scenario}.`);
  console.log(`Database now holds ${countEvents()} events.`);
  for (const a of created) console.log(`  alert [${a.severity}] ${a.title}`);
  console.log('Note: with no RING_CLIENT_ID set the app runs in demo mode and keeps this simulated data current.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
