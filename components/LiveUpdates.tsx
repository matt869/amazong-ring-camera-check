'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

const POLL_MS = 2000;

/**
 * Redraws the page within a couple of seconds of a new event arriving (a Ring
 * webhook, a webcam report, the simulator), instead of waiting for the next
 * minute's refresh. Asks only for the newest event id, so polling stays cheap.
 */
export default function LiveUpdates({ latestId }: { latestId: string | null }) {
  const router = useRouter();
  const known = useRef(latestId);
  const [connected, setConnected] = useState(true);

  // A redraw brings a new latestId from the server; keep in step with it.
  useEffect(() => {
    known.current = latestId;
  }, [latestId]);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/api/events?hours=48&limit=1', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const newest = ((await res.json()) as { events: { id: string }[] }).events[0]?.id ?? null;
        if (stopped) return;
        setConnected(true);
        if (newest !== known.current) {
          known.current = newest;
          router.refresh();
        }
      } catch {
        if (!stopped) setConnected(false);
      }
    };
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [router]);

  return (
    <span className={`live-pill${connected ? '' : ' live-off'}`} role="status">
      <span className="dot" aria-hidden />
      {connected ? 'Live' : 'Reconnecting…'}
    </span>
  );
}
