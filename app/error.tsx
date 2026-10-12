'use client';

import { useEffect } from 'react';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section className="card stack" style={{ marginTop: 24 }}>
      <h1>Something went wrong</h1>
      <p className="muted" style={{ margin: 0 }}>
        The check-in page couldn&apos;t load. Alerts keep running in the background. Details are in the server log
        {error.digest ? ` (reference ${error.digest})` : ''}.
      </p>
      <div>
        <button className="button" type="button" onClick={reset}>
          Try again
        </button>
      </div>
    </section>
  );
}
