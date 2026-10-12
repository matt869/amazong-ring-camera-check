import { NextResponse, type NextRequest } from 'next/server';
import { getDayReport, getDaySummary, runCheck } from '@/lib/checkin';

export const dynamic = 'force-dynamic';

/**
 * Current check-in status, the day's activity (today, or ?date=YYYY-MM-DD)
 * and the narrative summary. Also runs the rule check, so an external cron can
 * use it as a heartbeat.
 */
export async function GET(req: NextRequest) {
  const { created } = await runCheck();
  const report = getDayReport(req.nextUrl.searchParams.get('date') ?? undefined);
  const summary = await getDaySummary(report);
  return NextResponse.json({
    date: report.dateKey,
    status: report.status,
    summary,
    facts: report.facts,
    hourly: report.hourly,
    baseline: report.baseline,
    openAlerts: report.openAlerts,
    newAlerts: created,
  });
}
