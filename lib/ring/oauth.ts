import { getTokens, isLiveMode, saveTokens } from '../db';
import type { RingTokens } from './types';

/**
 * Demo mode: simulated data. On until a real source exists: Ring credentials,
 * or a webcam sensor added on the Setup page (which records live mode).
 */
export function isMockMode(): boolean {
  if (process.env.RING_MOCK === 'true') return true;
  return !process.env.RING_CLIENT_ID && !process.env.RING_REFRESH_TOKEN && !isLiveMode();
}

/** Signed in as a Ring account (npm run ring:login) rather than through partner OAuth. */
export function usesRingAccount(): boolean {
  return process.env.RING_MOCK !== 'true' && Boolean(process.env.RING_REFRESH_TOKEN);
}

export function redirectUri(): string {
  const base = process.env.APP_URL || 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/api/auth/ring/callback`;
}

export function authorizeUrl(state: string): string {
  const url = new URL(process.env.RING_AUTH_URL || 'https://oauth.ring.com/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.RING_CLIENT_ID ?? '');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', process.env.RING_OAUTH_SCOPE || 'client');
  url.searchParams.set('state', state);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function tokenRequest(params: Record<string, string>, previousRefresh?: string): Promise<RingTokens> {
  const res = await fetch(process.env.RING_TOKEN_URL || 'https://oauth.ring.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: process.env.RING_CLIENT_ID ?? '',
      client_secret: process.env.RING_CLIENT_SECRET ?? '',
      ...params,
    }),
  });
  if (!res.ok) {
    throw new Error(`Ring token request failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as TokenResponse;
  const tokens: RingTokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previousRefresh ?? '',
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

export async function exchangeCode(code: string): Promise<RingTokens> {
  if (isMockMode()) {
    const tokens = { accessToken: `mock-${code}`, refreshToken: 'mock-refresh', expiresAt: Date.now() + 365 * 86_400_000 };
    saveTokens(tokens);
    return tokens;
  }
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
}

export async function refreshTokens(refreshToken: string): Promise<RingTokens> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken);
}

/** A usable access token, refreshing it if it's about to expire. Null if never connected. */
export async function getAccessToken(): Promise<string | null> {
  const tokens = getTokens();
  if (!tokens) return null;
  if (tokens.expiresAt - Date.now() > 60_000 || isMockMode()) return tokens.accessToken;
  if (!tokens.refreshToken) return null;
  return (await refreshTokens(tokens.refreshToken)).accessToken;
}

/** Partner-OAuth tokens only count when partner OAuth is configured (demo saves fake ones). */
export function isConnected(): boolean {
  return usesRingAccount() || (Boolean(process.env.RING_CLIENT_ID) && getTokens() != null);
}
