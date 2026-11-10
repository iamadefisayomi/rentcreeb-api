import { env } from '../config/env';
import { HttpError } from './errors';

export interface NinSelfieResult {
  match: boolean;
  confidence: number;
  firstName?: string;
  lastName?: string;
  raw: unknown;
}

/**
 * Dojah NIN + selfie verification.
 * Docs: https://docs.dojah.io  (POST /api/v1/kyc/nin/verify  { nin, selfie_image(base64) })
 * NOTE: confirm the exact response shape against your Dojah plan; adjust the mapping below if it differs.
 */
export async function verifyNinWithSelfie(nin: string, selfieBase64: string): Promise<NinSelfieResult> {
  const res = await fetch(`${env.DOJAH_BASE_URL}/api/v1/kyc/nin/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: env.DOJAH_SECRET_KEY, AppId: env.DOJAH_APP_ID },
    body: JSON.stringify({ nin, selfie_image: selfieBase64 }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (res.status === 404 || json?.error?.toString().toLowerCase().includes('not found'))
    throw new HttpError(422, 'NIN not found', 'NIN_NOT_FOUND');
  if (!res.ok) throw new HttpError(502, 'Verification provider unavailable. Try again shortly.', 'VERIFICATION_PROVIDER_ERROR');

  const entity = json.entity ?? {};
  const sv = entity.selfie_verification ?? {};
  return {
    match: Boolean(sv.match),
    confidence: Number(sv.confidence_value ?? 0),
    firstName: entity.first_name ?? entity.firstname,
    lastName: entity.last_name ?? entity.surname,
    raw: { selfie_verification: sv }, // never persist the full NIN record
  };
}
