import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Config } from './config.ts';

export const createPool = (config: Config) => new pg.Pool({
  connectionString: config.DATABASE_URL, max: 12, connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000, application_name: 'mprovifilesharing',
});
export async function transaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
export function lockKey(value: string) {
  return createHash('sha256').update(value).digest().readBigInt64BE().toString();
}
export async function migrate(pool: Pool) {
  const directory = new URL('../migrations/', import.meta.url);
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey('mprovi:migrations')]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of (await readdir(directory)).filter((n) => /^\d+_.+\.sql$/.test(n)).sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query('SELECT sha256 FROM schema_migrations WHERE name=$1', [name]);
      if (existing.rowCount) {
        if (existing.rows[0].sha256 !== hash) throw new Error(`Migration déjà appliquée modifiée : ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [name, hash]);
    }
  });
}
