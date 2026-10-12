'use server';

import { redirect } from 'next/navigation';
import { getSettings } from '@/lib/db';
import { applyReply, readReplyToken } from '@/lib/escalation';

/**
 * Answers from the one-tap check-in page. Public (no login): the signed token
 * in the link is the authorization, and it's checked here, not only on the page.
 */
export async function replyAction(formData: FormData) {
  const token = String(formData.get('token') ?? '');
  const answer = formData.get('answer') === 'help' ? 'help' : 'ok';
  const link = readReplyToken(token);
  if (!link) redirect(`/r/${encodeURIComponent(token)}`);
  await applyReply(link.alertId, link.role, answer, getSettings());
  redirect(`/r/${token}?done=${answer}`);
}
