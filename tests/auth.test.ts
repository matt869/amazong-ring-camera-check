import { describe, expect, it } from 'vitest';
import { checkPassword, createSessionToken, isCronRequest, safeNextPath, verifySessionToken } from '../lib/auth';

describe('session tokens', () => {
  const now = 1_800_000_000_000;

  it('verifies its own tokens until they expire', () => {
    const token = createSessionToken(now, 'k1');
    expect(verifySessionToken(token, now + 1000, 'k1')).toBe(true);
    expect(verifySessionToken(token, now + 31 * 86_400_000, 'k1')).toBe(false);
  });

  it('rejects tampering, other keys and junk', () => {
    const token = createSessionToken(now, 'k1');
    const [exp, sig] = token.split('.');
    expect(verifySessionToken(`${Number(exp) + 1}.${sig}`, now, 'k1')).toBe(false);
    expect(verifySessionToken(token, now, 'k2')).toBe(false);
    expect(verifySessionToken(undefined, now, 'k1')).toBe(false);
    expect(verifySessionToken('nope', now, 'k1')).toBe(false);
    expect(verifySessionToken('123.', now, 'k1')).toBe(false);
  });
});

describe('checkPassword', () => {
  it('matches exactly and never accepts an unset password', () => {
    expect(checkPassword('hunter2', 'hunter2')).toBe(true);
    expect(checkPassword('hunter3', 'hunter2')).toBe(false);
    expect(checkPassword('', '')).toBe(false);
  });
});

describe('isCronRequest', () => {
  it('requires the configured bearer secret', () => {
    expect(isCronRequest('Bearer s3cret', 's3cret')).toBe(true);
    expect(isCronRequest('Bearer wrong', 's3cret')).toBe(false);
    expect(isCronRequest('s3cret', 's3cret')).toBe(false);
    expect(isCronRequest('Bearer ', undefined)).toBe(false);
  });
});

describe('safeNextPath', () => {
  it('only allows same-site paths', () => {
    expect(safeNextPath('/dashboard/timeline?date=2026-01-01')).toBe('/dashboard/timeline?date=2026-01-01');
    expect(safeNextPath('https://evil.example')).toBe('/dashboard');
    expect(safeNextPath('//evil.example')).toBe('/dashboard');
    expect(safeNextPath('/\\evil.example')).toBe('/dashboard');
    expect(safeNextPath(null)).toBe('/dashboard');
  });
});
