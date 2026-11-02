import pg from 'pg';
import { PgLocker } from './pg-locker.mjs';

if (!process.env.PHASE0_DATABASE_URL || !process.argv[2]) throw new Error('Configuration de verrou absente.');
const pool = new pg.Pool({ connectionString: process.env.PHASE0_DATABASE_URL, max: 1 });
const lock = new PgLocker(pool).newLock(process.argv[2]);
await lock.lock(new AbortController().signal);
process.stdout.write(`${JSON.stringify({ locked: true, pid: process.pid })}\n`);
// Le banc termine ce processus brutalement pour vérifier la libération serveur.
setInterval(() => {}, 1000);
