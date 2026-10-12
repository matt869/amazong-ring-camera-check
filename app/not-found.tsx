import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="card stack" style={{ marginTop: 24 }}>
      <h1>Page not found</h1>
      <p className="muted" style={{ margin: 0 }}>
        That page doesn&apos;t exist. <Link href="/dashboard">Go to today&apos;s check-in</Link>.
      </p>
    </section>
  );
}
