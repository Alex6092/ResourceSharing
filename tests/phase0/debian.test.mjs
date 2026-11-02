// Qualification effective : aucune simulation d'Apache, de TLS ou de PostgreSQL.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, unlink, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadFixture, pattern, replaceFixtureVersion } from './fixture.mjs';
import { startServer, stopServer, auth, createUpload, patchUpload, responseDigest } from './client.mjs';

const reportPath = resolve(process.env.PHASE0_REPORT || 'test-results/phase0-debian.json');
const report = {
  schemaVersion: 1, phase: 0, status: 'blocked', startedAt: new Date().toISOString(),
  environment: { platform: process.platform, node: process.versions.node }, checks: [],
  limitations: ['Aucun transfert de plus de 50 Go ni test de charge 30/50 clients dans ce jalon.'],
};
let primary;
let secondary;
let holder;
let infrastructureReady = false;
async function check(name, operation, { fatal = false } = {}) {
  const start = performance.now();
  try {
    await operation();
    report.checks.push({ name, status: 'passed', durationMs: Math.round(performance.now() - start) });
    console.log(`OK ${name}`);
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: String(error.message || error.code || 'Erreur').slice(0, 400) });
    console.error(`ECHEC ${name}`);
    if (fatal) throw error;
  }
}
async function waitForApache(origin) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return response.json();
    } catch { /* laisser démarrer Apache */ }
    await delay(100);
  }
  throw new Error('Apache HTTPS indisponible.');
}
async function startHolder(id) {
  const script = fileURLToPath(new URL('./lock-holder.mjs', import.meta.url));
  const child = spawn('runuser', ['-u', 'nobody', '--', process.execPath, script, id], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  let deadline;
  const info = await Promise.race([
    new Promise((accept, reject) => {
      child.on('error', reject);
      child.once('exit', () => reject(new Error('Le détenteur du verrou s’est arrêté.')));
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.includes('\n')) accept(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
      });
    }),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Verrou non acquis.')), 10000); }),
  ]).finally(() => clearTimeout(deadline));
  return { child, processPid: info.pid };
}

try {
  await check('Debian 13, Node 24 et configuration de qualification', async () => {
    assert.equal(process.platform, 'linux', 'Ce jalon exige Debian 13 ; les tests Windows ne le valident pas.');
    const release = await readFile('/etc/os-release', 'utf8');
    assert.match(release, /^ID=debian$/m);
    assert.match(release, /^VERSION_ID="?13"?$/m);
    assert.equal(Number(process.versions.node.split('.')[0]), 24);
    for (const key of ['PHASE0_ROOT', 'PHASE0_PUBLIC_ORIGIN', 'PHASE0_PORT', 'PHASE0_DATABASE_URL', 'NODE_EXTRA_CA_CERTS']) {
      assert.ok(process.env[key], `${key} requis ; utiliser le script Debian.`);
    }
    const url = new URL(process.env.PHASE0_PUBLIC_ORIGIN);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(process.env.PHASE0_RUN_AS, 'nobody');
  }, { fatal: true });
  infrastructureReady = true;
  const fixture = await loadFixture(process.env.PHASE0_ROOT);
  const [teacherA, teacherB, student] = fixture.identities;
  const origin = process.env.PHASE0_PUBLIC_ORIGIN;
  const options = {
    port: Number(process.env.PHASE0_PORT), publicOrigin: origin,
    databaseUrl: process.env.PHASE0_DATABASE_URL, runAs: 'nobody',
  };
  primary = await startServer(fixture, options);
  secondary = await startServer(fixture, { ...options, port: 0 });
  if (process.env.PHASE0_WORK) {
    await writeFile(join(process.env.PHASE0_WORK, 'api-primary.pid'), String(primary.processPid));
    await writeFile(join(process.env.PHASE0_WORK, 'api-secondary.pid'), String(secondary.processPid));
  }
  report.environment.debian = '13';
  report.environment.fixtureBytes = fixture.versions[0].size;
  report.environment.packageLockSha256 = createHash('sha256').update(
    await readFile(new URL('../../package-lock.json', import.meta.url)),
  ).digest('hex');
  await check('Apache HTTPS et PostgreSQL réels', async () => {
    const health = await waitForApache(origin);
    assert.equal(health.postgres, true);
    assert.equal(health.downloadStrategy, 'apache-xsendfile');
  }, { fatal: true });
  await check('API non privilégiée : objets lisibles mais non modifiables', async () => {
    const result = spawnSync('runuser', ['-u', 'nobody', '--', process.execPath,
      fileURLToPath(new URL('./permissions.mjs', import.meta.url)), fixture.root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
  const versionPath = `/download/${fixture.resourceId}/versions/${fixture.versions[0].id}`;
  const currentPath = `/download/${fixture.resourceId}`;
  await check('le backend ne transmet pas le contenu du téléchargement', async () => {
    const response = await fetch(`${primary.origin}${versionPath}`, { headers: auth(student) });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('x-sendfile'));
    assert.deepEqual(await responseDigest(response), {
      size: 0, sha256: createHash('sha256').digest('hex'),
    });
  });
  await check('Apache transmet le fichier entier, sans exposer X-Sendfile', async () => {
    const response = await fetch(`${origin}${versionPath}`, { headers: auth(student) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-sendfile'), null);
    assert.equal(response.headers.get('x-sendfile-temporary'), null);
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''debian-%C3%A9cole/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('cache-control'), /private/);
    const { size, sha256 } = await responseDigest(response);
    assert.equal(size, fixture.versions[0].size);
    assert.equal(sha256, fixture.versions[0].sha256);
  });
  await check('HEAD conserve taille, ETag et prise en charge Range', async () => {
    const response = await fetch(`${origin}${versionPath}`, { method: 'HEAD', headers: auth(student) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(fixture.versions[0].size));
    assert.equal(response.headers.get('etag'), `"${fixture.versions[0].sha256}"`);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
  });
  await check('Range et Content-Range exacts', async () => {
    const response = await fetch(`${origin}${versionPath}`, { headers: { ...auth(student), Range: 'bytes=101-228' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 101-228/${fixture.versions[0].size}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pattern(128, 101));
    const suffix = await fetch(`${origin}${versionPath}`, { headers: { ...auth(student), Range: 'bytes=-64' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), pattern(64, fixture.versions[0].size - 64));
  });
  await check('plage hors fichier : 416', async () => {
    const response = await fetch(`${origin}${versionPath}`, { headers: {
      ...auth(student), Range: `bytes=${fixture.versions[0].size + 1}-`,
    } });
    assert.equal(response.status, 416);
    await response.arrayBuffer();
  });
  await check('If-Range périmé renvoie un fichier complet', async () => {
    const response = await fetch(`${origin}${versionPath}`, { headers: {
      ...auth(student), Range: 'bytes=100-', 'If-Range': '"ancienne-version"',
    } });
    assert.equal(response.status, 200);
    assert.equal((await responseDigest(response)).sha256, fixture.versions[0].sha256);
  });
  await check('la revalidation ne contourne pas l’authentification', async () => {
    const etag = `"${fixture.versions[0].sha256}"`;
    const authenticated = await fetch(`${origin}${versionPath}`, { headers: { ...auth(student), 'If-None-Match': etag } });
    assert.equal(authenticated.status, 304);
    const anonymous = await fetch(`${origin}${versionPath}`, { headers: { 'If-None-Match': etag } });
    assert.equal(anonymous.status, 401);
  });
  await check('aucun accès direct au stockage et aucune injection X-Sendfile', async () => {
    for (const path of ['/objects/' + fixture.versions[0].id, '/incoming/', '/private/identities.json', '/fixture.json']) {
      const response = await fetch(`${origin}${path}`, { headers: {
        ...auth(student), 'X-Sendfile': join(fixture.root, 'private', 'identities.json'),
      } });
      assert.equal(response.status, 404);
    }
  });
  await check('le lien courant change de version sans modifier l’ancienne', async () => {
    await replaceFixtureVersion(fixture.root, fixture.versions[1].id);
    const redirect = await fetch(`${origin}${currentPath}`, { redirect: 'manual', headers: auth(student) });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('cache-control'), 'no-store');
    assert.equal(redirect.headers.get('location'), `${origin}/download/${fixture.resourceId}/versions/${fixture.versions[1].id}`);
    const oldVersion = await fetch(`${origin}${versionPath}`, { headers: auth(student) });
    assert.equal((await responseDigest(oldVersion)).sha256, fixture.versions[0].sha256);
    const newVersion = await fetch(redirect.headers.get('location'), { headers: auth(student) });
    assert.equal((await responseDigest(newVersion)).sha256, fixture.versions[1].sha256);
  });
  await check('tus via Apache : propriétaire et reprise après crash', async () => {
    const created = await createUpload(origin, teacherA, 1024 * 1024);
    assert.equal(created.status, 201);
    const url = created.headers.get('location');
    assert.ok(url.startsWith(`${origin}/tus/uploads/`));
    assert.equal((await patchUpload(url, teacherB, 0, pattern(64))).status, 403);
    assert.equal((await patchUpload(url, teacherA, 0, pattern(65536))).status, 204);
    await stopServer(primary, true);
    primary = await startServer(fixture, options);
    if (process.env.PHASE0_WORK) await writeFile(join(process.env.PHASE0_WORK, 'api-primary.pid'), String(primary.processPid));
    const head = await fetch(url, { method: 'HEAD', headers: { ...auth(teacherA), 'Tus-Resumable': '1.0.0' } });
    assert.equal(head.headers.get('upload-offset'), '65536');
    assert.equal((await patchUpload(url, teacherA, 65536, pattern(1024 * 1024 - 65536, 65536))).status, 204);
    const id = new URL(url).pathname.split('/').at(-1);
    const content = await readFile(join(fixture.root, 'incoming', id));
    assert.equal(createHash('sha256').update(content).digest('hex'), createHash('sha256').update(pattern(1024 * 1024)).digest('hex'));
  });
  await check('deux processus API partagent le verrou PostgreSQL', async () => {
    const created = await createUpload(origin, teacherA, 8192);
    assert.equal(created.status, 201);
    const path = new URL(created.headers.get('location')).pathname;
    const responses = await Promise.all([
      patchUpload(`${primary.origin}${path}`, teacherA, 0, pattern(4096)),
      patchUpload(`${secondary.origin}${path}`, teacherA, 0, pattern(4096)),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [204, 409]);
  });
  await check('un worker bloque tus ; son crash libère le verrou', async () => {
    const created = await createUpload(origin, teacherA, 200);
    assert.equal(created.status, 201);
    const url = created.headers.get('location');
    holder = await startHolder(new URL(url).pathname.split('/').at(-1));
    if (process.env.PHASE0_WORK) await writeFile(join(process.env.PHASE0_WORK, 'api-holder.pid'), String(holder.processPid));
    assert.equal((await patchUpload(url, teacherA, 0, pattern(100))).status, 423);
    const exited = once(holder.child, 'exit');
    process.kill(holder.processPid, 'SIGKILL');
    await exited;
    holder = undefined;
    assert.equal((await patchUpload(url, teacherA, 0, pattern(100))).status, 204);
  });
  await check('Apache ne sert pas un objet symbolique', async () => {
    const path = join(fixture.root, 'objects', fixture.versions[1].id);
    assert.equal((await lstat(path)).isFile(), true);
    await unlink(path);
    await symlink(join(fixture.root, 'private', 'identities.json'), path);
    const response = await fetch(`${origin}/download/${fixture.resourceId}/versions/${fixture.versions[1].id}`, { headers: auth(student) });
    assert.equal(response.status, 404);
  });
  report.status = report.checks.some((result) => result.status === 'failed') ? 'failed' : 'passed';
  if (report.status === 'failed') process.exitCode = 1;
} catch (error) {
  report.status = infrastructureReady ? 'failed' : 'blocked';
  report.reason = String(error.message || 'Qualification interrompue.').slice(0, 2000);
  process.exitCode = 1;
  console.error(report.status === 'blocked' ? 'Qualification Debian non exécutée : environnement requis absent.' : 'Qualification Debian échouée.');
} finally {
  if (holder) { try { process.kill(holder.processPid, 'SIGKILL'); } catch { /* déjà arrêté */ } }
  await Promise.all([stopServer(primary), stopServer(secondary)]);
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  console.log(`Rapport : ${reportPath}`);
}
