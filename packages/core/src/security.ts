import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { HttpError, insist } from './errors.ts';

export const token = () => randomBytes(32).toString('base64url');
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function equals(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function signature(secret: string, method: string, path: string, timestamp: string, nonce: string, body: string) {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update([method, path, timestamp, nonce, sha256(body)].join('\n')).digest('hex');
}
export function signRequest(secret: string, clientId: string, keyId: string, path: string, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = token();
  return {
    'content-type': 'application/json', 'x-client-id': clientId, 'x-key-id': keyId,
    'x-timestamp': timestamp, 'x-nonce': nonce,
    'x-signature': signature(secret, 'POST', path, timestamp, nonce, body),
  };
}
export async function verifyRequest(pool: Pool, secret: string, clientId: string, keyId: string,
  path: string, body: string, headers: Record<string, string | string[] | undefined>) {
  const client = headers['x-client-id'], key = headers['x-key-id'];
  const timestamp = headers['x-timestamp'], nonce = headers['x-nonce'], received = headers['x-signature'];
  insist(client === clientId && key === keyId && typeof timestamp === 'string' && /^\d{10}$/.test(timestamp)
    && Math.abs(Date.now() / 1000 - Number(timestamp)) <= 60 && typeof nonce === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(nonce)
    && typeof received === 'string' && /^[0-9a-f]{64}$/.test(received), 401, 'INVALID_SIGNATURE', 'Requête technique invalide.');
  insist(equals(signature(secret, 'POST', path, timestamp, nonce, body), received), 401, 'INVALID_SIGNATURE', 'Requête technique invalide.');
  try { await pool.query("INSERT INTO service_nonces(nonce,expires_at) VALUES($1,now()+interval '5 minutes')", [nonce]); }
  catch (error) {
    if ((error as { code?: string }).code === '23505') throw new HttpError(401, 'REPLAY', 'Requête technique déjà utilisée.');
    throw error;
  }
}
