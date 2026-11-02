// Explicit qualification: writes and hashes >50 GiB. Never part of routine CI.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../packages/core/src/config.ts';
import { createPool, migrate } from '../../packages/core/src/db.ts';
import { initializeQueue, queue } from '../../packages/core/src/queue.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { ValidationWorker } from '../../apps/worker/src/worker.ts';
import { moodleFixture } from '../integration/moodle-fixture.ts';

assert.equal(process.env.CONFIRM_LARGE_TEST, 'WRITE_50_GIB', 'Autorisation explicite du banc requise.');
const secret = randomBytes(32).toString('hex'), moodle = await moodleFixture(secret);
const config = loadConfig({ NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:1', MOODLE_ORIGIN: moodle.origin,
  DATABASE_URL: process.env.DATABASE_URL, STORAGE_ROOT: process.env.TEST_STORAGE_ROOT,
  STORAGE_MARKER: randomUUID(), SESSION_SECRET: randomBytes(32).toString('hex'), MOODLE_SHARED_SECRET: secret,
  MOODLE_CATALOG_SECRET: randomBytes(32).toString('hex'), MIN_FREE_BYTES: '0' });
const pool = createPool(config), boss = queue(config);
assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name, /^mprovi_test_/);
for (const area of ['incoming', 'objects', 'quarantine']) await mkdir(join(config.STORAGE_ROOT, area), { mode: 0o700 });
await writeFile(join(config.STORAGE_ROOT, '.mprovi-volume'), config.STORAGE_MARKER);
await migrate(pool); await initializeQueue(config); await boss.start();
const runtime = await buildApp(config, pool, boss);
const origin = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
config.APP_ORIGIN = origin; moodle.state.appOrigin = origin;
let peakRss = 0;
const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
const started = Date.now(), size = 50 * 1024 ** 3 + 17;
const output = { name: 'large-upload', sizeBytes: String(size), status: 'running', sha256: '', peakCombinedRssBytes: 0, seconds: 0, interruptions: 0 };
try {
  const begin = await fetch(`${origin}/auth/moodle/start`, { redirect: 'manual' });
  const authorize = await fetch(begin.headers.get('location')!, { redirect: 'manual' });
  const callback = await fetch(authorize.headers.get('location')!, { redirect: 'manual', headers: { Cookie: begin.headers.getSetCookie()[0].split(';')[0] } });
  const cookie = callback.headers.getSetCookie().find((c) => c.startsWith(config.cookieName + '='))!.split(';')[0];
  const profile = await (await fetch(`${origin}/api/v1/me`, { headers: { Cookie: cookie } })).json() as { csrfToken: string };
  const headers = { Cookie: cookie, Origin: origin, 'X-CSRF-Token': profile.csrfToken };
  const created = await fetch(`${origin}/api/v1/uploads`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'qualification-50-Gio.iso', folderId: null, sizeBytes: String(size), fingerprint: randomUUID() }) });
  assert.equal(created.status, 201, await created.clone().text());
  const upload = await created.json() as { id: string; uploadUrl: string; resourceId: string };
  const chunk = randomBytes(16 * 1024 ** 2), hash = createHash('sha256');
  let lastReport = Date.now();
  for (let offset = 0; offset < size;) {
    const data = chunk.subarray(0, Math.min(chunk.length, size - offset));
    const response = await fetch(upload.uploadUrl, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/offset+octet-stream',
      'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset) }, body: data });
    assert.equal(response.status, 204, await response.text());
    hash.update(data); offset += data.length;
    if (offset === 1024 ** 3) {
      const resumed = await fetch(upload.uploadUrl, { method: 'HEAD', headers: { ...headers, 'Tus-Resumable': '1.0.0' } });
      assert.equal(resumed.status, 200); assert.equal(Number(resumed.headers.get('Upload-Offset')), offset);
      output.interruptions++;
    }
    if (Date.now() - lastReport > 15000) { console.log(JSON.stringify({ receivedGiB: Math.round(offset / 1024 ** 3 * 10) / 10 })); lastReport = Date.now(); }
  }
  output.sha256 = hash.digest('hex');
  const final = await fetch(`${origin}/api/v1/uploads/${upload.id}/finalize`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ sha256: output.sha256 }) });
  assert.equal(final.status, 202);
  console.log('Transfert complet ; calcul SHA-256 et publication serveur en cours.');
  await new ValidationWorker(config, pool, boss).validate(upload.id);
  const completed = await runtime.uploads.get(upload.id);
  assert.equal(completed.state, 'completed'); assert.equal(completed.actual_sha256, output.sha256);
  assert.equal(String(completed.received_bytes), String(size));
  assert.ok(peakRss < 1.5 * 1024 ** 3, `Mémoire combinée client/API/worker excessive : ${peakRss}`);
  output.status = 'passed';
} catch (error) { output.status = 'failed'; throw error; }
finally {
  clearInterval(sample); output.peakCombinedRssBytes = peakRss; output.seconds = Math.round((Date.now() - started) / 1000);
  const report = process.env.TEST_REPORT_FILE || 'test-results/large-upload.json';
  await mkdir(join(report, '..'), { recursive: true }); await writeFile(report, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
  await runtime.app.close(); await boss.stop(); await pool.end(); await moodle.app.close();
}
