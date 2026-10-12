/**
 * Runs once when the Next.js server starts. Schedules the check-in rules so
 * alerts fire on time even when nobody has the dashboard open.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const minutes = Number(process.env.CHECK_INTERVAL_MINUTES) || 5;
  const { runCheck, startLiveSources } = await import('./lib/checkin');
  startLiveSources();

  const tick = () =>
    runCheck().then(
      ({ created }) => {
        if (created.length) console.log(`[scheduler] ${created.length} new alert(s)`);
      },
      (err) => console.error('[scheduler] check failed:', err),
    );

  void tick();
  setInterval(tick, minutes * 60_000).unref();
  console.log(`[scheduler] running check-in rules every ${minutes} min`);
}
