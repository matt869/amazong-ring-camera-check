import { redirect } from 'next/navigation';
import { authMode, safeNextPath, verifyLogin } from '@/lib/auth';
import { startSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

async function login(formData: FormData) {
  'use server';
  const next = safeNextPath(String(formData.get('next') ?? ''));
  if (!verifyLogin(String(formData.get('password') ?? ''))) {
    // Slow down guessing.
    await new Promise((r) => setTimeout(r, 1000));
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }
  await startSession();
  redirect(next);
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const mode = authMode();
  if (mode === 'open') redirect(safeNextPath(next));

  return (
    <div className="login">
      <section className="card stack">
        <h1>Sign in</h1>
        {mode === 'locked' ? (
          <p className="notice error">
            Real sensors are connected but no dashboard password is set. Add <code>APP_PASSWORD</code> to{' '}
            <code>.env.local</code> and restart the server. This dashboard shows when someone is home alone, so it stays
            locked until then.
          </p>
        ) : (
          <form action={login} className="form">
            {error && (
              <p className="notice error" role="alert">
                That password didn&apos;t match.
              </p>
            )}
            <input type="hidden" name="next" value={safeNextPath(next)} />
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus />
            </div>
            <div>
              <button className="button" type="submit">
                Sign in
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
