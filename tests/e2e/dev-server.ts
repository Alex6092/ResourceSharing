// Environnement de démonstration/tests isolé. Ne pas déployer en production.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../packages/core/src/config.ts';
import { createPool, migrate } from '../../packages/core/src/db.ts';
import { initializeQueue, queue } from '../../packages/core/src/queue.ts';
import { sha256 } from '../../packages/core/src/security.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { ValidationWorker } from '../../apps/worker/src/worker.ts';
import { moodleFixture } from '../integration/moodle-fixture.ts';
import { createServer } from 'vite';

if (!process.env.DATABASE_URL || !process.env.TEST_STORAGE_ROOT) throw new Error('Lancer test-integration-debian.sh demo.');
const secret = randomBytes(32).toString('hex'), moodle = await moodleFixture(secret, 3457);
moodle.state.appOrigin = 'http://127.0.0.1:5173';
const config = loadConfig({ NODE_ENV: 'test', APP_ORIGIN: moodle.state.appOrigin, MOODLE_ORIGIN: moodle.origin,
  DATABASE_URL: process.env.DATABASE_URL, STORAGE_ROOT: process.env.TEST_STORAGE_ROOT, STORAGE_MARKER: randomUUID(),
  SESSION_SECRET: randomBytes(32).toString('hex'), MOODLE_SHARED_SECRET: secret,
  MOODLE_CATALOG_SECRET: randomBytes(32).toString('hex'), MIN_FREE_BYTES: '0', PORT: '3000' });
const pool = createPool(config);
if (!/^mprovi_test_/.test((await pool.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Base de test requise.');
for (const area of ['incoming', 'objects', 'quarantine']) await mkdir(join(config.STORAGE_ROOT, area), { mode: 0o700 });
await writeFile(join(config.STORAGE_ROOT, '.mprovi-volume'), config.STORAGE_MARKER);
await migrate(pool); await initializeQueue(config);
const boss = queue(config); await boss.start();
const runtime = await buildApp(config, pool, boss), worker = new ValidationWorker(config, pool, boss);
const teacher = await runtime.identity.subject('42');
const examples = ['Debian 13 — atelier réseau.iso', 'Poste de développement.ova', 'Supports des travaux pratiques.zip', 'Environnement Python.7z'];
for (const name of examples) {
  const bytes = randomBytes(65536);
  const upload = await runtime.uploads.create(teacher, { name, sizeBytes: String(bytes.length), folderId: null, fingerprint: sha256(bytes) });
  await writeFile(join(config.STORAGE_ROOT, 'incoming', String(upload.id)), bytes);
  await runtime.uploads.finalize(teacher, String(upload.id), sha256(bytes));
  await worker.validate(String(upload.id));
}
await runtime.catalog.createFolder(teacher, null, 'Machines virtuelles');
await runtime.catalog.createFolder(teacher, null, 'Images ISO');
await boss.work<{ id: string }>('validate-upload', { batchSize: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
  for (const job of jobs) await worker.validate(job.data.id);
});
await runtime.app.listen({ host: '127.0.0.1', port: 3000 });
const vite = await createServer({ configFile: 'apps/web/vite.config.ts', server: { host: '127.0.0.1', port: 5173, strictPort: true } });
await vite.listen();
console.log(JSON.stringify({ ready: true, pid: process.pid, origin: config.APP_ORIGIN, mode: 'test-fixture-only' }));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => {
  if (stopping) return; stopping = true;
  await vite.close(); await runtime.app.close(); await boss.stop(); await pool.end(); await moodle.app.close();
});
