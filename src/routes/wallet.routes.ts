import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { paystack } from '../lib/paystack';
import { badRequest, forbidden, HttpError } from '../lib/errors';
import { fullName, kobo, paginate } from '../lib/common';
import { authenticate, requireVerified } from '../middleware/auth';

const r = Router();
r.use(authenticate);

r.get('/', async (req, res) => {
  const { from, to } = paginate(req.query);
  const wallet = (await db.from('wallets').select('available_kobo').eq('user_id', req.user.id).single()).data;
  const { data: held } = await db.from('escrows').select('amount_kobo, fee_kobo').eq('payee_id', req.user.id).eq('status', 'held');
  const escrowKobo = (held ?? []).reduce((s, e) => s + Number(e.amount_kobo) - Number(e.fee_kobo), 0);
  const { data: txs } = await db.from('wallet_transactions').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).range(from, to);
  const bank = (await db.from('bank_accounts').select('bank_name, account_number, account_name').eq('user_id', req.user.id).maybeSingle()).data;
  res.json({ availableKobo: wallet?.available_kobo ?? 0, inEscrowKobo: escrowKobo, bankAccount: bank, transactions: txs });
});

r.get('/banks', async (_req, res) => res.json({ banks: await paystack.listBanks() }));

r.put('/bank-account', requireVerified, async (req, res) => {
  const b = z.object({ bankCode: z.string(), bankName: z.string().optional(), accountNumber: z.string().regex(/^\d{10}$/) }).parse(req.body);
  const resolved = await paystack.resolveAccount(b.accountNumber, b.bankCode);
  const recipient = await paystack.createRecipient({ name: resolved.account_name, accountNumber: b.accountNumber, bankCode: b.bankCode });
  const row = unwrap(await db.from('bank_accounts').upsert({
    user_id: req.user.id, bank_code: b.bankCode, bank_name: b.bankName, account_number: b.accountNumber,
    account_name: resolved.account_name, paystack_recipient_code: recipient.recipient_code,
  }).select('bank_name, account_number, account_name').single());
  res.json({ bankAccount: row });
});

/** Debit first (atomic, fails on insufficient funds), then transfer. Webhook reverses on failure. */
r.post('/withdraw', requireVerified, async (req, res) => {
  const { amountKobo } = z.object({ amountKobo: kobo.min(100000) }).parse(req.body);
  const { data: bank } = await db.from('bank_accounts').select('*').eq('user_id', req.user.id).maybeSingle();
  if (!bank) throw badRequest('Add a bank account first', 'NO_BANK_ACCOUNT');
  const reference = `RC_WD_${randomUUID().replace(/-/g, '').slice(0, 18)}`;
  const { error } = await db.rpc('wallet_debit', { p_user: req.user.id, p_amount: amountKobo, p_kind: 'withdrawal', p_desc: 'Withdrawal', p_ref: reference });
  if (error) throw error.message.includes('INSUFFICIENT_FUNDS') ? forbidden('Insufficient balance', 'INSUFFICIENT_FUNDS') : new HttpError(500, error.message);
  const w = unwrap(await db.from('withdrawals').insert({ user_id: req.user.id, amount_kobo: amountKobo, reference }).select().single());
  try {
    await paystack.transfer({ amountKobo, recipient: bank.paystack_recipient_code, reference, reason: `RentCreeb payout to ${fullName(req.user)}` });
  } catch (err) {
    await db.from('withdrawals').update({ status: 'failed' }).eq('id', w.id);
    await db.rpc('wallet_credit', { p_user: req.user.id, p_amount: amountKobo, p_kind: 'withdrawal_reversal', p_desc: 'Withdrawal failed', p_ref: `wd-rev:${w.id}` });
    throw err;
  }
  res.status(202).json({ withdrawal: w, message: 'Withdrawal processing. Usually within 24 hours.' });
});

export default r;
