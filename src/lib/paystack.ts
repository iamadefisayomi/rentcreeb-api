import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { HttpError } from './errors';

const BASE = 'https://api.paystack.co';

async function ps<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) throw new HttpError(502, json.message ?? 'Paystack error', 'PAYSTACK_ERROR');
  return json.data as T;
}

export const paystack = {
  initialize: (p: { email: string; amountKobo: number; reference: string; metadata?: object }) =>
    ps<{ authorization_url: string; access_code: string; reference: string }>('/transaction/initialize', {
      method: 'POST',
      body: { email: p.email, amount: p.amountKobo, reference: p.reference, currency: 'NGN',
              callback_url: env.PAYSTACK_CALLBACK_URL, metadata: p.metadata },
    }),
  verify: (reference: string) =>
    ps<{ status: string; amount: number; reference: string; channel: string }>(`/transaction/verify/${encodeURIComponent(reference)}`),
  refund: (reference: string, amountKobo: number) =>
    ps('/refund', { method: 'POST', body: { transaction: reference, amount: amountKobo } }),
  listBanks: () => ps<{ name: string; code: string }[]>('/bank?country=nigeria&perPage=100'),
  resolveAccount: (accountNumber: string, bankCode: string) =>
    ps<{ account_name: string }>(`/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`),
  createRecipient: (p: { name: string; accountNumber: string; bankCode: string }) =>
    ps<{ recipient_code: string }>('/transferrecipient', {
      method: 'POST',
      body: { type: 'nuban', name: p.name, account_number: p.accountNumber, bank_code: p.bankCode, currency: 'NGN' },
    }),
  transfer: (p: { amountKobo: number; recipient: string; reference: string; reason?: string }) =>
    ps('/transfer', { method: 'POST', body: { source: 'balance', amount: p.amountKobo, recipient: p.recipient, reference: p.reference, reason: p.reason } }),
  validWebhook(raw: Buffer | undefined, signature: string | undefined) {
    if (!raw || !signature) return false;
    const expected = createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  },
};
