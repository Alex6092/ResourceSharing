import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, lstat, readFile, unlink, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { loadConfig } from '../../packages/core/src/config.ts';
import { createPool, migrate } from '../../packages/core/src/db.ts';
import { initializeQueue, queue } from '../../packages/core/src/queue.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { ValidationWorker } from '../../apps/worker/src/worker.ts';
import { sha256, signRequest } from '../../packages/core/src/security.ts';
import { moodleFixture } from './moodle-fixture.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { importAccessLog } from '../../packages/core/src/statistics.ts';

type Browser = { cookie: string; csrf: string; id: string };
test('MVP : SSO, droits, dépôt et publication avec PostgreSQL réel', { timeout: 120000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL && process.env.TEST_STORAGE_ROOT, 'Lancer deploy/scripts/test-integration-debian.sh.');
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const secret = randomBytes(32).toString('hex');
  const moodle = await moodleFixture(secret);
  const origin = `http://127.0.0.1:${port}`;
  moodle.state.appOrigin = origin;
  const config = loadConfig({
    NODE_ENV: 'test', APP_ORIGIN: origin, MOODLE_ORIGIN: moodle.origin,
    DATABASE_URL: process.env.DATABASE_URL, STORAGE_ROOT: process.env.TEST_STORAGE_ROOT,
    STORAGE_MARKER: randomUUID(), SESSION_SECRET: randomBytes(32).toString('hex'),
    MOODLE_SHARED_SECRET: secret, MOODLE_CATALOG_SECRET: randomBytes(32).toString('hex'), MIN_FREE_BYTES: '0',
  });
  const pool = createPool(config);
  const boss = queue(config);
  let closeApp: (() => Promise<unknown>) | undefined;
  t.after(async () => {
    await closeApp?.(); await boss.stop().catch(() => {}); await pool.end(); await moodle.app.close();
  });
  assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name, /^mprovi_test_/);
  assert.equal((await pool.query("SELECT to_regclass('public.users') AS existing")).rows[0].existing, null, 'La base de test doit être neuve.');
  for (const name of ['incoming', 'objects', 'quarantine']) await mkdir(join(config.STORAGE_ROOT, name), { mode: 0o700 });
  await writeFile(join(config.STORAGE_ROOT, '.mprovi-volume'), config.STORAGE_MARKER);
  await migrate(pool); await initializeQueue(config);
  await boss.start();
  const runtime = await buildApp(config, pool, boss);
  const { app, uploads } = runtime;
  closeApp = () => app.close();
  const worker = new ValidationWorker(config, pool, boss);
  await app.listen({ host: '127.0.0.1', port });

  async function login(subject: string, purpose = 'manage'): Promise<Browser> {
    moodle.state.subject = subject;
    const begin = await fetch(`${origin}/auth/moodle/start?purpose=${purpose}`, { redirect: 'manual' });
    assert.equal(begin.status, 302);
    const loginCookie = begin.headers.getSetCookie()[0].split(';')[0];
    const authorize = await fetch(begin.headers.get('location')!, { redirect: 'manual' });
    assert.equal(authorize.status, 302);
    const callback = await fetch(authorize.headers.get('location')!, { redirect: 'manual', headers: { Cookie: loginCookie } });
    assert.equal(callback.status, 302);
    const cookie = callback.headers.getSetCookie().find((value) => value.startsWith(`${config.cookieName}=`))!.split(';')[0];
    const me = await fetch(`${origin}/api/v1/me`, { headers: { Cookie: cookie } });
    if (purpose === 'download') return { cookie, csrf: '', id: '' };
    assert.equal(me.status, 200);
    const json = await me.json() as { csrfToken: string; id: string };
    return { cookie, csrf: json.csrfToken, id: json.id };
  }
  async function api(browser: Browser, method: string, path: string, body?: unknown) {
    return fetch(`${origin}${path}`, { method, redirect: 'manual', headers: {
      Cookie: browser.cookie, Origin: origin, 'X-CSRF-Token': browser.csrf,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  const teacher = await login('42'), other = await login('43'), admin = await login('44');
  const student = await login('45', 'download');
  let resource: any;
  let firstVersion: string;
  const content = randomBytes(128 * 1024 + 19);
  async function deposit(browser: Browser, name: string, data: Buffer, replace?: { id: string; revision: number }) {
    const created = await api(browser, 'POST', '/api/v1/uploads', { name, sizeBytes: String(data.length), folderId: null,
      fingerprint: sha256(data), ...(replace ? { replaceResourceId: replace.id, revision: replace.revision } : {}) });
    assert.equal(created.status, 201, await created.clone().text());
    const upload = await created.json() as { id: string; uploadUrl: string; resourceId: string };
    const patch = await fetch(upload.uploadUrl, { method: 'PATCH', headers: {
      Cookie: browser.cookie, Origin: origin, 'X-CSRF-Token': browser.csrf, 'Tus-Resumable': '1.0.0',
      'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream',
    }, body: new Uint8Array(data) });
    assert.equal(patch.status, 204, await patch.text());
    const final = await api(browser, 'POST', `/api/v1/uploads/${upload.id}/finalize`, { sha256: sha256(data) });
    assert.equal(final.status, 202, await final.text());
    return upload;
  }

  await t.test('SSO : identifiant stable, state lié au navigateur, code à usage unique', async () => {
    assert.equal((await login('42')).id, teacher.id);
    const begin = await fetch(`${origin}/auth/moodle/start`, { redirect: 'manual' });
    const auth = await fetch(begin.headers.get('location')!, { redirect: 'manual' });
    const callback = auth.headers.get('location')!;
    assert.equal((await fetch(callback, { redirect: 'manual' })).status, 403);
    const cookie = begin.headers.getSetCookie()[0].split(';')[0];
    assert.equal((await fetch(callback, { redirect: 'manual', headers: { Cookie: cookie } })).status, 302);
    assert.equal((await fetch(callback, { redirect: 'manual', headers: { Cookie: cookie } })).status, 403);
    moodle.state.expireCodes = true;
    const expired = await fetch(`${origin}/auth/moodle/start`, { redirect: 'manual' });
    const denied = await fetch(expired.headers.get('location')!, { redirect: 'manual' });
    assert.equal((await fetch(denied.headers.get('location')!, { redirect: 'manual', headers: { Cookie: expired.headers.getSetCookie()[0].split(';')[0] } })).status, 403);
    moodle.state.expireCodes = false;
  });
  await t.test('CSRF et étudiant : mutations et catalogue refusés', async () => {
    assert.equal((await api(student, 'GET', '/api/v1/resources')).status, 403);
    assert.equal((await fetch(`${origin}/api/v1/folders`, { method: 'POST', headers: { Cookie: teacher.cookie, 'Content-Type': 'application/json' }, body: '{"name":"interdit"}' })).status, 403);
    assert.equal((await api(teacher, 'POST', '/api/v1/folders', { name: '../sortie' })).status, 400);
  });
  await t.test('le fichier reçu reste invisible avant validation ; publication et empreinte', async () => {
    const upload = await deposit(teacher, 'debian-école.ova', content);
    assert.equal((await (await api(teacher, 'GET', '/api/v1/resources')).json() as any).items.length, 0);
    await worker.validate(upload.id);
    resource = await (await api(teacher, 'GET', `/api/v1/resources/${upload.resourceId}`)).json();
    assert.equal(resource.availability, 'ready'); assert.equal(resource.sha256, sha256(content));
    firstVersion = resource.currentVersionId;
    const file = await readFile(join(config.STORAGE_ROOT, 'objects', firstVersion));
    assert.equal(sha256(file), sha256(content));
    assert.equal((await lstat(join(config.STORAGE_ROOT, 'objects', firstVersion))).mode & 0o222, 0);
    const bytes = await api(student, 'GET', `/download/${resource.id}/versions/${firstVersion}`);
    assert.equal(bytes.status, 200); assert.equal((await bytes.arrayBuffer()).byteLength, 0);
    assert.ok(bytes.headers.get('x-sendfile')); assert.equal(bytes.headers.get('accept-ranges'), 'bytes');
  });
  await t.test('autrui ne modifie pas la ressource ; renommage et déplacement préservent le lien', async () => {
    assert.equal((await api(other, 'PATCH', `/api/v1/resources/${resource.id}`, { name: 'vole.ova', revision: resource.revision })).status, 403);
    const folder = await (await api(teacher, 'POST', '/api/v1/folders', { name: 'Machines virtuelles' })).json() as any;
    const changed = await api(teacher, 'PATCH', `/api/v1/resources/${resource.id}`, { name: 'debian-renommée.ova', folderId: folder.id, revision: resource.revision });
    assert.equal(changed.status, 200); const next = await changed.json() as any;
    assert.equal(next.downloadUrl, resource.downloadUrl); resource = next;
    assert.equal((await api(teacher, 'PATCH', `/api/v1/resources/${resource.id}`, { name: 'collision.ova', revision: 1 })).status, 409);
  });
  await t.test('remplacement validé : bascule du lien et conservation de la version précédente', async () => {
    const upload = await deposit(teacher, resource.name, Buffer.from('version 2'), resource);
    const pending = await (await api(teacher, 'GET', `/api/v1/resources/${resource.id}`)).json() as any;
    assert.equal(pending.currentVersionId, firstVersion);
    await worker.validate(upload.id);
    resource = await (await api(teacher, 'GET', `/api/v1/resources/${resource.id}`)).json();
    assert.notEqual(resource.currentVersionId, firstVersion);
    assert.equal((await api(student, 'GET', `/download/${resource.id}`)).headers.get('location'), `${origin}/download/${resource.id}/versions/${resource.currentVersionId}`);
    assert.equal((await readFile(join(config.STORAGE_ROOT, 'objects', firstVersion))).length, content.length);
  });
  await t.test('mauvaise empreinte : aucune publication et ancienne version intacte', async () => {
    const created = await api(teacher, 'POST', '/api/v1/uploads', { name: resource.name, sizeBytes: '3', fingerprint: 'bad-hash', replaceResourceId: resource.id, revision: resource.revision });
    const upload = await created.json() as any;
    const patch = await fetch(upload.uploadUrl, { method: 'PATCH', headers: { Cookie: teacher.cookie, Origin: origin, 'X-CSRF-Token': teacher.csrf,
      'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: Buffer.from('abc') });
    assert.equal(patch.status, 204);
    await api(teacher, 'POST', `/api/v1/uploads/${upload.id}/finalize`, { sha256: '0'.repeat(64) });
    await worker.validate(upload.id);
    assert.equal((await uploads.get(upload.id)).state, 'error');
    assert.equal((await uploads.get(upload.id)).error_code, 'HASH_MISMATCH');
    assert.equal((await (await api(teacher, 'GET', `/api/v1/resources/${resource.id}`)).json() as any).currentVersionId, resource.currentVersionId);
  });
  await t.test('reprise de publication après interruption entre renommage et transaction', async () => {
    const upload = await deposit(teacher, 'récupération.iso', Buffer.from('persistant'));
    const crashing = new ValidationWorker(config, pool, boss, { afterRename: async () => { throw new Error('Simulation interruption publication'); } });
    await assert.rejects(crashing.validate(upload.id));
    assert.equal((await uploads.get(upload.id)).state, 'publishing');
    assert.equal((await (await api(teacher, 'GET', '/api/v1/resources?q=récupération')).json() as any).items.length, 0);
    // A dead worker may leave its pg-boss claim active. Reconciliation must
    // create runnable work without waiting for that claim's 24-hour timeout.
    const claimed = await boss.fetch<{ id: string }>('validate-upload', { batchSize: 100 });
    assert.ok(claimed.some((job) => job.data.id === upload.id));
    await worker.reconcile();
    const resumed = await boss.fetch<{ id: string }>('validate-upload', { batchSize: 100 });
    assert.ok(resumed.some((job) => job.data.id === upload.id));
    await worker.validate(upload.id);
    assert.equal((await uploads.get(upload.id)).state, 'completed');
  });
  await t.test('dossiers partagés : cycle et modification d’une branche d’autrui refusés', async () => {
    const folder = await (await api(teacher, 'POST', '/api/v1/folders', { name: 'Partagé' })).json() as any;
    const child = await (await api(other, 'POST', '/api/v1/folders', { name: 'Autrui', parentId: folder.id })).json() as any;
    assert.equal((await api(teacher, 'PATCH', `/api/v1/folders/${folder.id}`, { name: 'Interdit', parentId: null, revision: 1 })).status, 403);
    assert.equal((await api(admin, 'PATCH', `/api/v1/folders/${folder.id}`, { name: 'Cycle', parentId: child.id, revision: 1 })).status, 400);
    assert.equal((await api(teacher, 'DELETE', `/api/v1/folders/${folder.id}`, { revision: 1 })).status, 409);
  });
  await t.test('noms de fichiers et dossiers partagent un espace unique sans tenir compte de la casse', async () => {
    const folder = await api(teacher, 'POST', '/api/v1/folders', { name: 'Collision.iso' });
    assert.equal(folder.status, 201);
    assert.equal((await api(teacher, 'POST', '/api/v1/uploads', { name: 'COLLISION.iso', folderId: null, sizeBytes: '3', fingerprint: 'collision' })).status, 409);
    assert.equal((await api(teacher, 'POST', '/api/v1/folders', { name: 'récupération.iso' })).status, 409);
    assert.equal((await api(teacher, 'POST', '/api/v1/folders', { name: 'École' })).status, 201);
    assert.equal((await api(teacher, 'POST', '/api/v1/folders', { name: 'école' })).status, 409);
    const found = await (await api(teacher, 'GET', '/api/v1/resources?q=RÉCUPÉRATION')).json() as { items: unknown[] };
    assert.equal(found.items.length, 1);
  });
  await t.test('compte API limité, révocable et sans mutation', async () => {
    const created = await api(admin, 'POST', '/api/v1/service-accounts', { name: 'Agent lecteur', scopes: ['resources:read'] });
    assert.equal(created.status, 201); const service = await created.json() as any;
    const headers = { Authorization: `Bearer ${service.token}` };
    assert.equal((await fetch(`${origin}/api/v1/resources`, { headers })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/folders`, { headers })).status, 403);
    assert.equal((await fetch(`${origin}/api/v1/folders`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"name":"interdit"}' })).status, 403);
    await api(admin, 'DELETE', `/api/v1/service-accounts/${service.id}`);
    assert.equal((await fetch(`${origin}/api/v1/resources`, { headers })).status, 401);
  });
  await t.test('rejeu d’un appel catalogue signé refusé', async () => {
    const path = '/api/v1/integrations/moodle/catalogue';
    const body = JSON.stringify({ subject: '42', action: 'list', query: {} });
    const headers = signRequest(config.MOODLE_CATALOG_SECRET, config.MOODLE_CLIENT_ID, config.MOODLE_KEY_ID, path, body);
    assert.equal((await fetch(`${origin}${path}`, { method: 'POST', headers, body })).status, 200);
    assert.equal((await fetch(`${origin}${path}`, { method: 'POST', headers, body })).status, 401);
  });
  await t.test('MCP réel via stdio : recherche, disponibilité et lien, sans outil de mutation', async () => {
    const created = await api(admin, 'POST', '/api/v1/service-accounts', { name: 'MCP qualification', scopes: ['resources:read', 'folders:read', 'availability:read'] });
    const service = await created.json() as { id: string; token: string };
    const transport = new StdioClientTransport({ command: process.execPath, args: ['packages/mcp/src/main.ts'],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), NODE_ENV: 'test', FILESHARING_BASE_URL: origin, FILESHARING_API_TOKEN: service.token } });
    const client = new Client({ name: 'qualification', version: '1' });
    try {
      await client.connect(transport);
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['folders_list', 'resources_check_availability', 'resources_get', 'resources_get_download_link', 'resources_search']);
      const result = await client.callTool({ name: 'resources_search', arguments: { query: 'debian', page: 1, limit: 50 } });
      assert.equal(result.isError, undefined);
      assert.ok(JSON.stringify(result).includes(resource.id));
      const link = await client.callTool({ name: 'resources_get_download_link', arguments: { resourceId: resource.id } });
      assert.equal(link.isError, undefined); assert.ok(JSON.stringify(link).includes(resource.downloadUrl));
      await api(admin, 'DELETE', `/api/v1/service-accounts/${service.id}`);
      assert.equal((await client.callTool({ name: 'resources_get', arguments: { resourceId: resource.id } })).isError, true);
    } finally { await client.close(); }
  });
  await t.test('sauvegarde catalogue et objets, puis restauration vers une base vierge et contrôle SHA-256', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'mprovi-restore-'));
    const name = `mprovi_test_restored_${process.pid}`;
    const url = new URL(config.DATABASE_URL); url.pathname = '/' + name;
    const target = createPool({ ...config, DATABASE_URL: url.href });
    try {
      await pool.query("INSERT INTO backup_leases(id,expires_at) VALUES($1,now()+interval '1 hour')", [randomUUID()]);
      await promisify(execFile)('/usr/lib/postgresql/17/bin/pg_dump', ['--format=custom', '--file=' + join(scratch, 'catalogue.dump'), config.DATABASE_URL]);
      await cp(join(config.STORAGE_ROOT, 'objects'), join(scratch, 'objects'), { recursive: true });
      await pool.query(`CREATE DATABASE ${name}`);
      await promisify(execFile)('/usr/lib/postgresql/17/bin/pg_restore', ['--dbname=' + url.href, '--no-owner', '--no-acl', '--exit-on-error', join(scratch, 'catalogue.dump')]);
      const restored = await target.query('SELECT id,size_bytes,sha256 FROM resource_versions WHERE purged_at IS NULL');
      assert.ok(restored.rowCount! >= 3);
      for (const row of restored.rows) {
        const bytes = await readFile(join(scratch, 'objects', row.id));
        assert.equal(String(bytes.length), row.size_bytes); assert.equal(sha256(bytes), row.sha256);
      }
      assert.equal((await target.query('SELECT current_version_id FROM resources WHERE id=$1', [resource.id])).rows[0].current_version_id, resource.currentVersionId);
    } finally {
      await target.end(); await pool.query(`DROP DATABASE IF EXISTS ${name}`);
      await pool.query('DELETE FROM backup_leases'); await rm(scratch, { recursive: true, force: true });
    }
  });
  await t.test('perte des capacités et suspension Moodle bloquent immédiatement les opérations', async () => {
    moodle.people.get('43')!.capabilities = [];
    assert.equal((await api(other, 'POST', '/api/v1/folders', { name: 'Droits retirés' })).status, 403);
    moodle.people.get('45')!.active = false;
    assert.equal((await api(student, 'GET', `/download/${resource.id}/versions/${resource.currentVersionId}`)).status, 403);
  });
  await t.test('statistiques Apache : octets réels, Range distincts et import idempotent', async () => {
    const path = join(config.STORAGE_ROOT, 'access-test.log');
    const line = `2026-11-02 GET /download/${resource.id}/versions/${resource.currentVersionId} 206 123\n`;
    await writeFile(path, line + line + `2026-11-02 HEAD /download/${resource.id} 403 0\n`);
    await importAccessLog(pool, path); await importAccessLog(pool, path);
    const result = await pool.query('SELECT requests,bytes_sent,errors FROM download_aggregates WHERE resource_id=$1', [resource.id]);
    assert.equal(result.rows[0].requests, '3'); assert.equal(result.rows[0].bytes_sent, '246'); assert.equal(result.rows[0].errors, '1');
  });
  await t.test('corbeille, restauration et disponibilité réelle', async () => {
    assert.equal((await api(teacher, 'DELETE', `/api/v1/resources/${resource.id}`, { revision: resource.revision })).status, 200);
    const deleted = await (await api(teacher, 'GET', `/api/v1/resources/${resource.id}`)).json() as any;
    assert.equal((await api(teacher, 'GET', `/download/${resource.id}`)).status, 410);
    const restored = await api(teacher, 'POST', `/api/v1/resources/${resource.id}/restore`, { revision: deleted.revision });
    assert.equal(restored.status, 200); resource = await restored.json();
    await unlink(join(config.STORAGE_ROOT, 'objects', resource.currentVersionId));
    await worker.reconcile();
    assert.equal((await (await api(teacher, 'GET', `/api/v1/resources/${resource.id}/availability`)).json() as any).available, false);
    assert.equal((await api(teacher, 'GET', `/download/${resource.id}`)).status, 503);
  });
  await t.test('OpenAPI et audit ne renvoient aucun secret ni chemin disque', async () => {
    const schema = await api(teacher, 'GET', '/api/v1/openapi');
    assert.equal(schema.status, 200);
    const document = await schema.json() as any;
    assert.ok(document.paths['/api/v1/uploads']);
    const response = await api(admin, 'GET', '/api/v1/audit');
    const text = await response.text();
    assert.ok(!text.includes(teacher.cookie.split('=')[1]) && !text.includes(config.STORAGE_ROOT));
    assert.ok((JSON.parse(text) as any).items.some((event: any) => event.action === 'upload.published'));
    assert.ok((JSON.parse(text) as any).items.some((event: any) => event.action === 'upload.begin' && event.requestId));
    assert.ok((JSON.parse(text) as any).items.some((event: any) => event.action === 'login' && event.result !== 'success'));
  });
});
