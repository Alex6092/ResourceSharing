// Non-root isolated Apache + real application + PostgreSQL, loopback load only.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, copyFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:https';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../../packages/core/src/config.ts';
import { createPool, migrate } from '../../packages/core/src/db.ts';
import { queue, initializeQueue } from '../../packages/core/src/queue.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { ValidationWorker } from '../../apps/worker/src/worker.ts';
import { moodleFixture } from '../integration/moodle-fixture.ts';

const storage = process.env.TEST_STORAGE_ROOT!;
assert.ok(storage && process.env.DATABASE_URL);
const port = 18444, origin = `https://127.0.0.1:${port}`;
const secret = randomBytes(32).toString('hex'), moodle = await moodleFixture(secret);
moodle.state.appOrigin = origin;
const config = loadConfig({ NODE_ENV: 'test', APP_ORIGIN: origin, MOODLE_ORIGIN: moodle.origin, DATABASE_URL: process.env.DATABASE_URL,
  STORAGE_ROOT: storage, STORAGE_MARKER: randomUUID(), SESSION_SECRET: randomBytes(32).toString('hex'),
  MOODLE_SHARED_SECRET: secret, MOODLE_CATALOG_SECRET: randomBytes(32).toString('hex'), MIN_FREE_BYTES: '0' });
for (const area of ['incoming', 'objects', 'quarantine']) await mkdir(join(storage, area), { mode: 0o700 });
await writeFile(join(storage, '.mprovi-volume'), config.STORAGE_MARKER);
const pool = createPool(config), boss = queue(config);
assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name, /^mprovi_test_/);
await migrate(pool); await initializeQueue(config); await boss.start();
const runtime = await buildApp(config, pool, boss), worker = new ValidationWorker(config, pool, boss);
const api = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
const work = join(storage, 'httpd'); await mkdir(work, { mode: 0o700 });
await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
  '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem')]);
const ca = await readFile(join(work, 'cert.pem'));
const modules = ['mpm_event', 'authz_core', 'authz_host', 'headers', 'proxy', 'proxy_http', 'ssl', 'socache_shmcb', 'xsendfile', 'alias'];
const uid = (await promisify(execFile)('id', ['-un'])).stdout.trim(), gid = (await promisify(execFile)('id', ['-gn'])).stdout.trim();
await writeFile(join(work, 'httpd.conf'), `ServerRoot "${work}"
DefaultRuntimeDir "${work}"
PidFile "${work}/pid"
Listen 127.0.0.1:${port}
ServerName localhost
User ${uid}
Group ${gid}
${modules.map((name) => `LoadModule ${name}_module /usr/lib/apache2/modules/mod_${name}.so`).join('\n')}
StartServers 2
ServerLimit 4
ThreadsPerChild 25
MaxRequestWorkers 100
KeepAlive On
MaxRanges 1
EnableSendfile Off
EnableMMAP Off
SSLEngine On
SSLCertificateFile "${work}/cert.pem"
SSLCertificateKeyFile "${work}/key.pem"
SSLSessionCache "shmcb:${work}/ssl(512000)"
XSendFile On
XSendFilePath "${storage}/objects"
RequestHeader unset X-Sendfile
<Directory />
 Require all denied
 Options -Indexes -ExecCGI -FollowSymLinks
</Directory>
# Public reference is synthetic benchmark content, never production storage.
Alias /benchmark-only "${work}/reference.bin"
<Directory "${work}">
 Require all granted
</Directory>
ProxyPass /download/ ${api}/download/
ProxyPassReverse /download/ ${api}/download/
ErrorLog "${work}/error.log"
LogLevel warn
`);
const apache = spawn('/usr/sbin/apache2', ['-f', join(work, 'httpd.conf'), '-DFOREGROUND'], { stdio: ['ignore', 'ignore', 'pipe'] });
let apacheErrors = ''; apache.stderr.on('data', (chunk) => { apacheErrors += String(chunk); });
const results: Record<string, unknown> = { status: 'running', network: 'VM loopback; not an Internet/LAN throughput qualification', loads: [] };
let peak = 0; const sampling = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 100);
function https(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; bytes: number; sha256: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(origin + path, { ca, headers, method }, (response) => {
      const hash = createHash('sha256'); let bytes = 0;
      response.on('data', (data) => { hash.update(data); bytes += data.length; });
      response.on('end', () => resolve({ status: response.statusCode!, bytes, sha256: hash.digest('hex'), headers: response.headers }));
      response.on('error', reject);
    }); req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('HTTPS timeout'))); req.end();
  });
}
try {
  let listening = false;
  for (let i = 0; i < 40; i++) {
    try { await https('/benchmark-only'); listening = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  assert.ok(listening, apacheErrors);
  const begin = await fetch(`${api}/auth/moodle/start`, { redirect: 'manual' });
  const authorize = await fetch(begin.headers.get('location')!, { redirect: 'manual' });
  const callbackUrl = new URL(authorize.headers.get('location')!);
  const callback = await fetch(api + callbackUrl.pathname + callbackUrl.search, { redirect: 'manual', headers: { Cookie: begin.headers.getSetCookie()[0].split(';')[0] } });
  const cookie = callback.headers.getSetCookie().find((c) => c.startsWith(config.cookieName + '='))!.split(';')[0];
  const teacher = await runtime.identity.subject('42');
  const bytes = randomBytes(32 * 1024 ** 2), digest = createHash('sha256').update(bytes).digest('hex');
  const upload = await runtime.uploads.create(teacher, { name: 'apache-qualification.iso', folderId: null, sizeBytes: String(bytes.length), fingerprint: digest });
  await writeFile(join(storage, 'incoming', String(upload.id)), bytes);
  await runtime.uploads.finalize(teacher, String(upload.id), digest); await worker.validate(String(upload.id));
  const resource = await runtime.catalog.get(String(upload.resourceId), teacher);
  const path = `/download/${resource.id}/versions/${resource.currentVersionId}`;
  await copyFile(join(storage, 'objects', String(resource.currentVersionId)), join(work, 'reference.bin')); await chmod(join(work, 'reference.bin'), 0o644);
  const direct = await fetch(`${api}${path}`, { headers: { Cookie: cookie } });
  assert.equal((await direct.arrayBuffer()).byteLength, 0); assert.ok(direct.headers.get('x-sendfile'));
  const full = await https(path, { Cookie: cookie }); assert.equal(full.status, 200); assert.equal(full.sha256, digest); assert.equal(full.headers['x-sendfile'], undefined);
  const head = await https(path, { Cookie: cookie }, 'HEAD'); assert.equal(head.bytes, 0); assert.equal(Number(head.headers['content-length']), bytes.length);
  const range = await https(path, { Cookie: cookie, Range: 'bytes=2-17' }); assert.equal(range.status, 206); assert.equal(range.sha256, createHash('sha256').update(bytes.subarray(2, 18)).digest('hex'));
  assert.equal((await https(path, { Cookie: cookie, Range: `bytes=${bytes.length + 1}-` })).status, 416);
  assert.equal((await https(path, { Cookie: cookie, Range: 'bytes=2-17', 'If-Range': '"outdated"' })).status, 200);
  assert.notEqual((await https(path)).status, 200);
  for (const clients of [10, 30, 50]) {
    const benchmark = async (target: string, auth: boolean) => {
      const start = performance.now();
      const transfers = await Promise.all(Array.from({ length: clients }, () => https(target, auth ? { Cookie: cookie } : {})));
      for (const transfer of transfers) { assert.equal(transfer.status, 200); assert.equal(transfer.sha256, digest); }
      return Math.round(clients * bytes.length / ((performance.now() - start) / 1000));
    };
    const reference = await benchmark('/benchmark-only', false), delegated = await benchmark(path, true);
    (results.loads as unknown[]).push({ clients, referenceBytesPerSecond: reference, delegatedBytesPerSecond: delegated, ratio: delegated / reference });
    console.log(JSON.stringify({ clients, status: 'passed', ratio: delegated / reference }));
  }
  results.status = 'passed';
} catch (error) { results.status = 'failed'; results.error = error instanceof Error ? error.message : String(error); throw error; }
finally {
  clearInterval(sampling); results.peakCombinedRssBytes = peak;
  await writeFile(process.env.TEST_REPORT_FILE || 'test-results/apache-app.json', JSON.stringify(results, null, 2));
  apache.kill('SIGTERM'); await new Promise<void>((resolve) => apache.exitCode !== null ? resolve() : apache.once('exit', () => resolve()));
  await runtime.app.close(); await boss.stop(); await pool.end(); await moodle.app.close();
}
