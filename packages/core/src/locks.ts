import type { Pool, PoolClient } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { lockKey } from './db.ts';

export class PgLocker {
  pool: Pool;
  timeout: number;
  constructor(pool: Pool, timeout = 10000) { this.pool = pool; this.timeout = timeout; }
  newLock(id: string) {
    const pool = this.pool;
    const timeout = this.timeout;
    const key = lockKey(`mprovi:upload:${id}`);
    let client: PoolClient | undefined;
    return {
      async lock(signal: AbortSignal) {
        const connection = await pool.connect();
        const until = Date.now() + timeout;
        try {
          while (!signal.aborted) {
            const result = await connection.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [key]);
            if (result.rows[0].acquired) { client = connection; return; }
            if (Date.now() >= until) break;
            await delay(50, undefined, { signal });
          }
          throw { status_code: 423, body: 'Transfert occupé. Réessayez.' };
        } catch (error) { connection.release(true); throw error; }
      },
      async unlock() {
        if (!client) return;
        const connection = client;
        client = undefined;
        try {
          const result = await connection.query('SELECT pg_advisory_unlock($1::bigint) AS released', [key]);
          connection.release(!result.rows[0].released);
        } catch (error) { connection.release(true); throw error; }
      },
    };
  }
  async using<T>(id: string, callback: () => Promise<T>) {
    const lock = this.newLock(id);
    await lock.lock(AbortSignal.timeout(this.timeout + 1000));
    try { return await callback(); } finally { await lock.unlock(); }
  }
}
