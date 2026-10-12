import { getTokens } from '../db';
import { getAccessToken, refreshTokens } from './oauth';

export class RingNotConnectedError extends Error {
  constructor() {
    super('Ring account is not connected. Visit /api/auth/ring/login first.');
  }
}

/** Authenticated JSON request against the Ring API, retrying once after a token refresh on 401. */
export async function ringRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new RingNotConnectedError();

  const send = (accessToken: string) =>
    fetch(`${(process.env.RING_API_BASE || 'https://api.ring.com').replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    });

  let res = await send(token);
  if (res.status === 401) {
    const refresh = getTokens()?.refreshToken;
    if (!refresh) throw new RingNotConnectedError();
    res = await send((await refreshTokens(refresh)).accessToken);
  }
  if (!res.ok) {
    throw new Error(`Ring API ${init.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}
