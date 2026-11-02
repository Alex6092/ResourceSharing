import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Même clé pour tus et pour un futur worker de publication. Le verrou est lié
// à une connexion PostgreSQL : sa fermeture libère le verrou après un crash.
export class PgLocker {
  constructor(pool, { timeout = 3000 } = {}) {
    this.pool = pool;
    this.timeout = timeout;
  }

  newLock(id) {
    const key = createHash('sha256').update(`mprovi:upload:${id}`).digest().readBigInt64BE().toString();
    const pool = this.pool;
    const timeout = this.timeout;
    let client;
    let held = false;
    return {
      async lock(signal) {
        if (client) throw new Error('Verrou déjà demandé.');
        client = await pool.connect();
        const deadline = Date.now() + timeout;
        try {
          while (!signal.aborted) {
            const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [key]);
            held = result.rows[0].acquired;
            if (held) return;
            if (Date.now() >= deadline) break;
            await delay(40, undefined, { signal });
          }
          throw { status_code: 423, body: 'Transfert verrouillé. Réessayez.' };
        } catch (error) {
          // Détruire aussi une connexion dont le résultat de lock est incertain.
          client.release(true);
          client = undefined;
          held = false;
          if (signal.aborted) throw { status_code: 409, body: 'Requête interrompue.' };
          throw error;
        }
      },
      async unlock() {
        if (!client || !held) return;
        const connection = client;
        client = undefined;
        held = false;
        try {
          const result = await connection.query('SELECT pg_advisory_unlock($1::bigint) AS released', [key]);
          connection.release(!result.rows[0].released);
        } catch (error) {
          connection.release(true);
          throw error;
        }
      },
    };
  }
}
