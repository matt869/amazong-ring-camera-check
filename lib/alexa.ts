import { verify as verifySignature, X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { getDayReport, getDaySummary } from './checkin';
import { getSettings } from './db';
import { getWeekDigest, getWeekReport } from './digest';

/**
 * Alexa custom skill: a caregiver asks "how's Mom today?" and hears the daily
 * note. Enabled only when ALEXA_SKILL_ID is set. Every request is checked the
 * way Amazon requires for skills hosted outside Lambda: certificate URL rules,
 * the certificate chain up to a trusted root, the Signature-256 header over the
 * raw body, a fresh timestamp, and this skill's ID.
 */

export function alexaSkillId(): string | null {
  return process.env.ALEXA_SKILL_ID || null;
}

/** Amazon's rules for SignatureCertChainUrl. */
export function isValidCertUrl(raw: string | null): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // URL normalizes the path (so "/echo.api/../" can't sneak past) and lowercases scheme and host.
  return (
    url.protocol === 'https:' &&
    url.hostname === 's3.amazonaws.com' &&
    (url.port === '' || url.port === '443') &&
    url.pathname.startsWith('/echo.api/')
  );
}

const MAX_SKEW_MS = 150_000;
const chainCache = new Map<string, X509Certificate[]>();
let trustedRoots: X509Certificate[] | null = null;

interface VerifyDeps {
  fetchChain?: (url: string) => Promise<string>;
  roots?: X509Certificate[];
}

async function loadChain(url: string, deps: VerifyDeps): Promise<X509Certificate[]> {
  const cached = chainCache.get(url);
  if (cached) return cached;
  const pem = deps.fetchChain ? await deps.fetchChain(url) : await (await fetch(url)).text();
  const certs = (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((c) => new X509Certificate(c));
  if (certs.length) chainCache.set(url, certs);
  return certs;
}

export type AlexaVerification = { ok: true } | { ok: false; reason: string };

export async function verifyAlexaRequest(
  rawBody: string,
  headers: { certUrl: string | null; signature: string | null },
  now = Date.now(),
  deps: VerifyDeps = {},
): Promise<AlexaVerification> {
  const skillId = alexaSkillId();
  if (!skillId) return { ok: false, reason: 'skill not configured' };

  let body: AlexaRequestBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'invalid JSON' };
  }
  const appId = body.context?.System?.application?.applicationId ?? body.session?.application?.applicationId;
  if (appId !== skillId) return { ok: false, reason: 'wrong skill' };
  const ts = Date.parse(body.request?.timestamp ?? '');
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, reason: 'stale request' };

  if (!isValidCertUrl(headers.certUrl) || !headers.signature) return { ok: false, reason: 'bad certificate url or signature' };
  const chain = await loadChain(headers.certUrl!, deps);
  const leaf = chain[0];
  if (!leaf) return { ok: false, reason: 'no certificate' };
  const inDate = (c: X509Certificate) => Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo);
  if (!chain.every(inDate)) return { ok: false, reason: 'certificate expired' };
  if (!(leaf.subjectAltName ?? '').split(/,\s*/).includes('DNS:echo-api.amazon.com')) return { ok: false, reason: 'wrong certificate subject' };
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) return { ok: false, reason: 'broken chain' };
  }
  const roots = deps.roots ?? (trustedRoots ??= tls.rootCertificates.map((p) => new X509Certificate(p)));
  const top = chain[chain.length - 1];
  const anchored = roots.some((r) => r.fingerprint256 === top.fingerprint256 || (top.checkIssued(r) && top.verify(r.publicKey)));
  if (!anchored) return { ok: false, reason: 'untrusted certificate' };

  const ok = verifySignature('sha256', Buffer.from(rawBody, 'utf8'), leaf.publicKey, Buffer.from(headers.signature, 'base64'));
  return ok ? { ok: true } : { ok: false, reason: 'bad signature' };
}

// --- requests and replies ----------------------------------------------------------

export interface AlexaRequestBody {
  session?: { application?: { applicationId?: string } };
  context?: { System?: { application?: { applicationId?: string } } };
  request?: { type?: string; timestamp?: string; intent?: { name?: string } };
}

export interface AlexaResponse {
  version: '1.0';
  response: { outputSpeech?: { type: 'PlainText'; text: string }; shouldEndSession?: boolean };
}

const say = (text: string, end = true): AlexaResponse => ({
  version: '1.0',
  response: { outputSpeech: { type: 'PlainText', text: text.replace(/[“”]/g, '"').replace(/[’]/g, "'") }, shouldEndSession: end },
});

export async function handleAlexaRequest(body: AlexaRequestBody, now = Date.now()): Promise<AlexaResponse> {
  const type = body.request?.type;
  const intent = body.request?.intent?.name;
  if (type === 'SessionEndedRequest') return { version: '1.0', response: {} };

  if (type === 'LaunchRequest' || intent === 'DailySummaryIntent') {
    const report = getDayReport(undefined, now);
    const summary = await getDaySummary(report, now);
    const open = report.openAlerts.filter((a) => a.severity !== 'info');
    const lead = open.length ? `${report.status.headline}. ${open.map((a) => a.title).join('. ')}.` : `${report.status.headline}.`;
    return say(`${lead} ${summary.text}`);
  }
  if (intent === 'WeeklyDigestIntent') {
    const report = getWeekReport(undefined, now);
    return say((await getWeekDigest(report, now)).text);
  }
  if (intent === 'AMAZON.HelpIntent') {
    const name = getSettings().residentName;
    return say(`You can ask how ${name} is today, or how ${name}'s week went.`, false);
  }
  if (intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent') return say('Goodbye.');
  return say('Sorry, I can tell you how today is going, or how the week went.', false);
}
