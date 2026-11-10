import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { db } from '../lib/supabase';
import { paystack } from '../lib/paystack';
import { logger } from '../lib/logger';
import { forbidden, notFound } from '../lib/errors';
import { fullName, paginate } from '../lib/common';
import { authenticate } from '../middleware/auth';
import { confirmPayment } from '../services/paymentProcessor';

export const webhookRouter = Router();
const r = Router();

/** Paystack webhook. Mounted BEFORE auth; verified by HMAC signature over the raw body. */
webhookRouter.post('/paystack', async (req, res) => {
  if (!paystack.validWebhook(req.rawBody, req.headers['x-paystack-signature'] as string | undefined)) return res.status(401).end();
  res.sendStatus(200); // ack fast, process after
  const { event, data } = req.body ?? {};
  try {
    if (event === 'charge.success') await confirmPayment(data.reference);
    if (event === 'transfer.success') await db.from('withdrawals').update({ status: 'success' }).eq('reference', data.reference);
    if (event === 'transfer.failed' || event === 'transfer.reversed') {
      const { data: w } = await db.from('withdrawals').update({ status: event === 'transfer.failed' ? 'failed' : 'reversed' })
        .eq('reference', data.reference).eq('status', 'pending').select().maybeSingle();
      if (w) await db.rpc('wallet_credit', { p_user: w.user_id, p_amount: w.amount_kobo, p_kind: 'withdrawal_reversal', p_desc: 'Withdrawal reversed', p_ref: `wd-rev:${w.id}` });
    }
  } catch (err) { logger.error({ err, event }, 'webhook processing failed'); }
});

r.use(authenticate);

/** Client calls this after the Paystack sheet closes, as a fallback to the webhook. */
r.get('/verify/:reference', async (req, res) => {
  const { data: p } = await db.from('payments').select('user_id').eq('reference', req.params.reference).maybeSingle();
  if (!p) throw notFound('Payment not found');
  if (p.user_id !== req.user.id) throw forbidden();
  const result = await confirmPayment(req.params.reference);
  res.json({ status: result.status });
});

/** Transaction history. ?purpose=inspection,subscription,... */
r.get('/', async (req, res) => {
  const { from, to } = paginate(req.query);
  const purpose = typeof req.query.purpose === 'string' ? req.query.purpose.split(',') : null;
  let q = db.from('payments').select('id, purpose, reference, amount_kobo, status, channel, paid_at, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).range(from, to);
  if (purpose) q = q.in('purpose', purpose);
  res.json({ payments: (await q).data });
});

async function ownPayment(id: string, userId: string) {
  const { data } = await db.from('payments').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  if (!data) throw notFound('Receipt not found');
  return data;
}

r.get('/:id/receipt', async (req, res) => res.json({ receipt: await ownPayment(req.params.id, req.user.id) }));

r.get('/:id/receipt.pdf', async (req, res) => {
  const p = await ownPayment(req.params.id, req.user.id);
  if (p.status === 'pending') throw notFound('No receipt for an unpaid transaction');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${p.reference}.pdf"`);
  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);
  doc.fontSize(22).text('RentCreeb', { align: 'left' }).moveDown(0.2);
  doc.fontSize(12).fillColor('#666').text('Payment receipt').moveDown(1.5).fillColor('#000');
  const rows: [string, string][] = [
    ['Reference', p.reference], ['Customer', fullName(req.user)], ['Purpose', p.purpose.replace('_', ' ')],
    ['Amount', `NGN ${(Number(p.amount_kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
    ['Status', p.status], ['Channel', p.channel ?? '-'], ['Date', new Date(p.paid_at ?? p.created_at).toLocaleString('en-NG')],
  ];
  rows.forEach(([k, v]) => doc.fontSize(11).fillColor('#666').text(k, { continued: true }).fillColor('#000').text(`   ${v}`).moveDown(0.4));
  doc.end();
});

export default r;
