import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authMode, SESSION_COOKIE, verifySessionToken } from '@/lib/auth';
import { isMockMode } from '@/lib/ring/oauth';
import './globals.css';

// The header reads the session cookie, so no page can be pre-rendered as static.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { default: 'Home Check-in', template: '%s · Home Check-in' },
  description:
    'Ring alerts you when something happens. Home Check-in alerts you when something that should happen doesn’t: a quiet daily check-in for someone living alone.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f5f2' },
    { media: '(prefers-color-scheme: dark)', color: '#121211' },
  ],
};

async function signOut() {
  'use server';
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const signedIn = authMode() === 'password' && verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);

  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <div className="shell">
          <header className="topbar">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden>
                ◎
              </span>
              Home Check-in
              {isMockMode() && (
                <span className="badge" title="No real sensors yet; showing simulated activity">
                  Demo data
                </span>
              )}
            </Link>
            <nav className="nav" aria-label="Main">
              <Link href="/dashboard">Today</Link>
              <Link href="/dashboard/timeline">Timeline</Link>
              <Link href="/dashboard/week">Week</Link>
              <Link href="/dashboard/trends">Trends</Link>
              <Link href="/dashboard/settings">Settings</Link>
              <Link href="/setup">Set up</Link>
              {signedIn && (
                <form action={signOut}>
                  <button type="submit" className="nav-button">
                    Sign out
                  </button>
                </form>
              )}
            </nav>
          </header>
          <main id="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
