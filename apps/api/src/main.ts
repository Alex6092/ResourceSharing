import { loadConfig } from '../../../packages/core/src/config.ts';
import { createPool } from '../../../packages/core/src/db.ts';
import { queue } from '../../../packages/core/src/queue.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const pool = createPool(config);
pool.on('error', () => console.error('Connexion PostgreSQL interrompue.'));
const boss = queue(config);
await boss.start();
const { app } = await buildApp(config, pool, boss);
await app.listen({ host: '127.0.0.1', port: config.PORT });
console.log(`API démarrée sur 127.0.0.1:${config.PORT}.`);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await app.close(); await boss.stop(); await pool.end();
});
