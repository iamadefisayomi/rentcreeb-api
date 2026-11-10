import { Resend } from 'resend';
import { env } from '../config/env';
import { logger } from './logger';

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export async function sendEmail(to: string, subject: string, html: string) {
  if (!resend) return logger.debug({ to, subject }, '[DEV EMAIL skipped]');
  try { await resend.emails.send({ from: env.EMAIL_FROM, to, subject, html }); }
  catch (err) { logger.error({ err }, 'email failed'); }
}
