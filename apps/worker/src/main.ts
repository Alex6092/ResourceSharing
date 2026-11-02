import { loadConfig } from '../../../packages/core/src/config.ts';
import { createPool } from '../../../packages/core/src/db.ts';
import { queue } from '../../../packages/core/src/queue.ts';
import { ValidationWorker } from './worker.ts';

const config = loadConfig(), pool = createPool(config), boss = queue(config, false, true);
pool.on('error', () => console.error('Connexion PostgreSQL du worker interrompue.'));
await boss.start();
const worker = new ValidationWorker(config, pool, boss);
await worker.storage.ready();
await boss.work<{ id: string }>('validate-upload', { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => {
  for (const job of jobs) await worker.validate(job.data.id);
});
let maintenanceRunning = false;
let maintenance: Promise<void> = Promise.resolve();
async function maintain() {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try { await worker.reconcile(); }
  catch { console.error('Réconciliation incomplète ; nouvel essai au prochain passage.'); }
  finally { maintenanceRunning = false; }
}
maintenance = maintain();
const timer = setInterval(() => { if (!maintenanceRunning) maintenance = maintain(); }, 60000);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  await maintenance; await boss.stop({ graceful: true, timeout: 300000 }); await pool.end();
});
console.log('Worker de validation démarré.');
