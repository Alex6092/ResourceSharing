import { z } from 'zod';
import { resolve } from 'node:path';

const secret = z.string().regex(/^[0-9a-f]{64,128}$/i).refine((value) => value.length % 2 === 0);
const schema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  APP_ORIGIN: z.url(), MOODLE_ORIGIN: z.url(), DATABASE_URL: z.string().min(1),
  STORAGE_ROOT: z.string().min(1), STORAGE_MARKER: z.uuid(),
  SESSION_SECRET: secret, MOODLE_SHARED_SECRET: secret, MOODLE_CATALOG_SECRET: secret,
  MOODLE_CLIENT_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).default('mprovifilesharing'),
  MOODLE_KEY_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).default('v1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MIN_FREE_BYTES: z.coerce.bigint().min(0n).default(10737418240n),
  MAX_ACTIVE_UPLOADS: z.coerce.number().int().min(1).max(100).default(6),
  MAX_USER_UPLOADS: z.coerce.number().int().min(1).max(20).default(3),
  UPLOAD_IDLE_DAYS: z.coerce.number().int().min(1).default(7),
  RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Configuration invalide : ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const c = parsed.data;
  for (const key of ['APP_ORIGIN', 'MOODLE_ORIGIN'] as const) {
    const url = new URL(c[key]);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`${key} doit être une origine sans chemin ni identifiants.`);
    if (c.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('HTTPS est obligatoire en production.');
    c[key] = url.origin;
  }
  if (new Set([c.SESSION_SECRET, c.MOODLE_SHARED_SECRET, c.MOODLE_CATALOG_SECRET]).size !== 3) throw new Error('Utiliser trois secrets distincts.');
  return {
    ...c, STORAGE_ROOT: resolve(c.STORAGE_ROOT),
    secureCookies: c.APP_ORIGIN.startsWith('https:'),
    cookieName: c.APP_ORIGIN.startsWith('https:') ? '__Host-mprovi' : 'mprovi_dev',
  };
}
export type Config = ReturnType<typeof loadConfig>;
