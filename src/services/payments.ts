import { randomUUID } from 'crypto';
import { db, unwrap } from '../lib/supabase';
import { paystack } from '../lib/paystack';
import { HttpError } from '../lib/errors';

export type Purpose = 'inspection' | 'subscription' | 'rent' | 'rentsave' | 'job_escrow';
type Refs = Partial<Record<'booking_id' | 'subscription_id' | 'job_id' | 'quote_id' | 'tenancy_id' | 'rent_payment_id' | 'rentsave_plan_id', string>>;

/** Creates a pending payment row and a Paystack transaction. Returns what the RN client needs. */
export async function createPayment(user: Profile, purpose: Purpose, amountKobo: number, refs: Refs = {}) {
  if (!user.email) throw new HttpError(400, 'Account has no email', 'NO_EMAIL');
  const reference = `RC_${purpose.toUpperCase()}_${randomUUID().replace(/-/g, '').slice(0, 18)}`;
  const payment = unwrap(
    await db.from('payments').insert({ user_id: user.id, purpose, reference, amount_kobo: amountKobo, ...refs }).select().single(),
  );
  const init = await paystack.initialize({ email: user.email, amountKobo, reference, metadata: { purpose, payment_id: payment.id } });
  await db.from('payments').update({ access_code: init.access_code }).eq('id', payment.id);
  return { paymentId: payment.id as string, reference, authorizationUrl: init.authorization_url, accessCode: init.access_code, amountKobo };
}
