import cron from 'node-cron';
import { db } from '../lib/supabase';
import { logger } from '../lib/logger';
import { notify } from '../services/notify';

/**
 * Housekeeping. If you run multiple API instances, run this on ONE instance
 * (or move to Supabase pg_cron / a worker) so jobs don't fire twice.
 */
export function startScheduler() {
  // Every 10 min: expire unpaid bookings (30 min window) and stale OTPs.
  cron.schedule('*/10 * * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 60000).toISOString();
      await db.from('bookings').update({ status: 'expired' }).eq('status', 'pending_payment').lt('created_at', cutoff);
      await db.from('otp_codes').delete().lt('expires_at', new Date(Date.now() - 86400000).toISOString());
    } catch (err) { logger.error({ err }, 'cron: bookings/otp cleanup failed'); }
  });

  // Hourly: expire subscriptions (listings get hidden by the search query) and flag overdue rent.
  cron.schedule('0 * * * *', async () => {
    try {
      const { data: expired } = await db.from('subscriptions').update({ status: 'expired' }).eq('status', 'active').lt('expires_at', new Date().toISOString()).select('agent_id');
      for (const s of expired ?? []) await notify(s.agent_id, 'subscription_expired', 'Subscription expired', 'Renew your plan to make your listings visible again.');
      await db.from('rent_payments').update({ status: 'overdue' }).eq('status', 'due').lt('due_date', new Date().toISOString().slice(0, 10));
    } catch (err) { logger.error({ err }, 'cron: subscriptions/rent failed'); }
  });

  // Daily 8am (Lagos = UTC+1 → 07:00 UTC): rent due in 3 days.
  cron.schedule('0 7 * * *', async () => {
    try {
      const d = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const { data } = await db.from('rent_payments').select('amount_kobo, tenancies(tenant_id, id)').eq('status', 'due').eq('due_date', d);
      for (const rp of (data ?? []) as any[])
        await notify(rp.tenancies.tenant_id, 'rent_reminder', 'Rent due in 3 days', `₦${(rp.amount_kobo / 100).toLocaleString()} is due on ${d}.`, { tenancyId: rp.tenancies.id });
    } catch (err) { logger.error({ err }, 'cron: rent reminders failed'); }
  });
}
