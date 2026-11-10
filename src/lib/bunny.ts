import { createHash, randomUUID } from 'crypto';
import { env } from '../config/env';
import { HttpError } from './errors';

const safe = (n: string) => n.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(-60);

/** Upload to Bunny Storage. `isPrivate` uses the token-protected zone (IDs, NIN slips, certificates). */
export async function uploadToBunny(buf: Buffer, folder: string, filename: string, isPrivate = false) {
  const zone = isPrivate ? env.BUNNY_PRIVATE_STORAGE_ZONE : env.BUNNY_STORAGE_ZONE;
  const key = isPrivate ? env.BUNNY_PRIVATE_STORAGE_KEY : env.BUNNY_STORAGE_KEY;
  if (!zone || !key) throw new HttpError(500, 'Bunny storage not configured', 'BUNNY_CONFIG');

  const path = `${folder}/${randomUUID()}-${safe(filename)}`;
  const res = await fetch(`https://${env.BUNNY_STORAGE_HOST}/${zone}/${path}`, {
    method: 'PUT',
    headers: { AccessKey: key, 'Content-Type': 'application/octet-stream' },
    body: buf as unknown as BodyInit,
  });
  if (!res.ok) throw new HttpError(502, `Bunny upload failed (${res.status})`, 'BUNNY_UPLOAD');
  return { path, url: isPrivate ? null : `${env.BUNNY_CDN_URL}/${path}` };
}

export async function deleteFromBunny(urlOrPath: string, isPrivate = false) {
  const zone = isPrivate ? env.BUNNY_PRIVATE_STORAGE_ZONE : env.BUNNY_STORAGE_ZONE;
  const key = isPrivate ? env.BUNNY_PRIVATE_STORAGE_KEY : env.BUNNY_STORAGE_KEY;
  if (!zone || !key) return;
  const path = urlOrPath.replace(`${env.BUNNY_CDN_URL}/`, '');
  await fetch(`https://${env.BUNNY_STORAGE_HOST}/${zone}/${path}`, { method: 'DELETE', headers: { AccessKey: key } }).catch(() => {});
}

/** Bunny "Token Authentication" (basic): base64url(sha256(key + path + expires)). */
export function signPrivateUrl(path: string, ttlSeconds = 300) {
  if (!env.BUNNY_PRIVATE_CDN_URL || !env.BUNNY_PRIVATE_TOKEN_KEY) throw new HttpError(500, 'Private CDN not configured');
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const p = '/' + path;
  const token = createHash('sha256').update(env.BUNNY_PRIVATE_TOKEN_KEY + p + expires).digest('base64')
    .replace(/\n/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${env.BUNNY_PRIVATE_CDN_URL}${p}?token=${token}&expires=${expires}`;
}
