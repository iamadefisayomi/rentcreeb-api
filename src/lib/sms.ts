import AfricasTalking from 'africastalking';
import { env, isProd } from '../config/env';
import { logger } from './logger';

const at = env.AT_API_KEY ? AfricasTalking({ apiKey: env.AT_API_KEY, username: env.AT_USERNAME }) : null;

export async function sendSms(to: string, message: string) {
  if (!at) {
    if (isProd) logger.error('Africa\'s Talking not configured; SMS not sent');
    else logger.info({ to, message }, '[DEV SMS]');
    return;
  }
  try {
    const res = await at.SMS.send({ to: [to], message, ...(env.AT_SENDER_ID ? { from: env.AT_SENDER_ID } : {}) });
    logger.debug({ res }, 'sms sent');
  } catch (err) {
    logger.error({ err }, 'sms failed');
  }
}
