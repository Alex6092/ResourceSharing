import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, lstat, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, pattern, replaceFixtureVersion } from './fixture.mjs';
import { startServer, stopServer, auth, createUpload, patchUpload } from './client.mjs';
import { buildServer } from './server.mjs';

test('Phase 0 locale : vrais transferts tus, sans simuler Apache ou PostgreSQL', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mprovi-phase0-'));
  let server;
  t.after(async () => {
    await stopServer(server);
    // Suppression restreinte au répertoire temporaire créé par cette suite.
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('mprovi-phase0-')) {
      throw new Error('Nettoyage hors du répertoire de test refusé.');
    }
    await rm(root, { recursive: true, force: true });
  });
  const fixture = await createFixture(root);
  const [teacherA, teacherB, student] = fixture.identities;
  server = await startServer(fixture);

  await t.test('les fichiers de contrôle restent lisibles avec umask 077', { skip: process.platform === 'win32' ? 'Permissions Unix.' : false }, async () => {
    const oldMask = process.umask(0o077);
    try {
      const restricted = await createFixture(join(root, 'strict-umask'), 64);
      assert.equal((await lstat(join(restricted.root, 'objects'))).mode & 0o777, 0o755);
      assert.equal((await lstat(join(restricted.root, 'private'))).mode & 0o777, 0o700);
      assert.equal((await lstat(join(restricted.root, 'private', 'identities.json'))).mode & 0o777, 0o600);
      for (const path of ['fixture.json', '.phase0-volume']) {
        assert.equal((await lstat(join(restricted.root, path))).mode & 0o777, 0o644);
      }
      await replaceFixtureVersion(restricted.root, restricted.versions[1].id);
      assert.equal((await lstat(join(restricted.root, 'fixture.json'))).mode & 0o777, 0o644);
    } finally { process.umask(oldMask); }
  });

  await t.test('le contrôle de volume interdit un marqueur différent', async () => {
    await assert.rejects(buildServer({ root, marker: 'autre-volume' }), /Marqueur/);
  });

  await t.test('un anonyme et un étudiant ne peuvent pas créer de dépôt', async () => {
    const anonymous = await fetch(`${server.origin}/tus/uploads`, {
      method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': '10' },
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await createUpload(server.origin, student, 10)).status, 403);
  });

  await t.test('longueur supérieure à 50 Gio acceptée sans précharger ni allouer le fichier', async () => {
    const created = await createUpload(server.origin, teacherA, 50 * 1024 ** 3 + 1);
    assert.equal(created.status, 201);
    const url = created.headers.get('location');
    const head = await fetch(url, { method: 'HEAD', headers: { ...auth(teacherA), 'Tus-Resumable': '1.0.0' } });
    assert.equal(head.headers.get('upload-length'), String(50 * 1024 ** 3 + 1));
    assert.equal(head.headers.get('upload-offset'), '0');
    const file = await lstat(join(root, 'incoming', new URL(url).pathname.split('/').at(-1)));
    assert.equal(file.size, 0);
    assert.equal((await fetch(url, { method: 'DELETE', headers: { ...auth(teacherA), 'Tus-Resumable': '1.0.0' } })).status, 204);
  });

  await t.test('propriétaire imposé côté serveur et vérifié à chaque méthode', async () => {
    const metadata = `owner ${Buffer.from('teacherB').toString('base64')}`;
    const created = await createUpload(server.origin, teacherA, 20, metadata);
    assert.equal(created.status, 201);
    const url = created.headers.get('location');
    for (const method of ['HEAD', 'DELETE']) {
      const response = await fetch(url, { method, headers: { ...auth(teacherB), 'Tus-Resumable': '1.0.0' } });
      assert.equal(response.status, 403);
    }
    assert.equal((await patchUpload(url, teacherB, 0, pattern(10))).status, 403);
    assert.equal((await patchUpload(url, student, 0, pattern(10))).status, 403);
    assert.equal((await fetch(url, { headers: auth(teacherA) })).status, 405);
    const head = await fetch(url, { method: 'HEAD', headers: { ...auth(teacherA), 'Tus-Resumable': '1.0.0' } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('upload-offset'), '0');
  });

  await t.test('origine différente refusée avant écriture', async () => {
    const response = await fetch(`${server.origin}/tus/uploads`, { method: 'POST', headers: {
      ...auth(teacherA), 'Tus-Resumable': '1.0.0', 'Upload-Length': '10', Origin: 'https://autre.example',
    } });
    assert.equal(response.status, 403);
  });

  await t.test('longueur différée et taille non représentable refusées', async () => {
    const deferred = await fetch(`${server.origin}/tus/uploads`, { method: 'POST', headers: {
      ...auth(teacherA), 'Tus-Resumable': '1.0.0', 'Upload-Defer-Length': '1',
    } });
    assert.equal(deferred.status, 400);
    assert.equal((await createUpload(server.origin, teacherA, '9007199254740992')).status, 400);
  });

  await t.test('un transfert partiel ne devient jamais un téléchargement', async () => {
    const created = await createUpload(server.origin, teacherA, 100);
    assert.equal(created.status, 201);
    const url = created.headers.get('location');
    const id = new URL(url).pathname.split('/').at(-1);
    assert.equal((await patchUpload(url, teacherA, 0, pattern(20))).status, 204);
    assert.equal((await fetch(`${server.origin}/download/${id}`, { headers: auth(student) })).status, 404);
    assert.equal((await fetch(`${server.origin}/download/${fixture.resourceId}/versions/${id}`, { headers: auth(student) })).status, 404);
  });

  await t.test('reprise après crash réel du processus et intégrité SHA-256', async () => {
    const size = 4 * 1024 * 1024 + 31;
    const created = await createUpload(server.origin, teacherA, size);
    const path = new URL(created.headers.get('location')).pathname;
    assert.equal(created.status, 201);
    const first = await patchUpload(`${server.origin}${path}`, teacherA, 0, pattern(1024 * 1024));
    assert.equal(first.status, 204);
    await stopServer(server, true);
    server = await startServer(fixture);
    const head = await fetch(`${server.origin}${path}`, { method: 'HEAD', headers: { ...auth(teacherA), 'Tus-Resumable': '1.0.0' } });
    assert.equal(head.headers.get('upload-offset'), String(1024 * 1024));
    const last = await patchUpload(`${server.origin}${path}`, teacherA, 1024 * 1024, pattern(size - 1024 * 1024, 1024 * 1024));
    assert.equal(last.status, 204);
    assert.equal(last.headers.get('upload-offset'), String(size));
    const content = await readFile(join(root, 'incoming', path.split('/').at(-1)));
    assert.equal(createHash('sha256').update(content).digest('hex'), createHash('sha256').update(pattern(size)).digest('hex'));
    const cancelled = await fetch(`${server.origin}${path}`, { method: 'DELETE', headers: { ...auth(teacherA), 'Tus-Resumable': '1.0.0' } });
    assert.equal(cancelled.status, 400, 'un transfert terminé ne doit pas être supprimé via tus');
  });

  await t.test('deux PATCH au même offset ne doublent pas le contenu', async () => {
    const created = await createUpload(server.origin, teacherA, 8192);
    const url = created.headers.get('location');
    const responses = await Promise.all([
      patchUpload(url, teacherA, 0, pattern(4096)), patchUpload(url, teacherA, 0, pattern(4096)),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [204, 409]);
    const head = await fetch(url, { method: 'HEAD', headers: { ...auth(teacherA), 'Tus-Resumable': '1.0.0' } });
    assert.equal(head.headers.get('upload-offset'), '4096');
  });

  await t.test('annulation persistante d’un transfert incomplet', async () => {
    const created = await createUpload(server.origin, teacherA, 100);
    const url = created.headers.get('location');
    assert.equal((await patchUpload(url, teacherA, 0, pattern(20))).status, 204);
    assert.equal((await fetch(url, { method: 'DELETE', headers: { ...auth(teacherA), 'Tus-Resumable': '1.0.0' } })).status, 204);
    assert.equal((await fetch(url, { method: 'HEAD', headers: { ...auth(teacherA), 'Tus-Resumable': '1.0.0' } })).status, 404);
  });

  await t.test('le backend renvoie seulement X-Sendfile, sans contenu de fichier', async () => {
    const path = `/download/${fixture.resourceId}/versions/${fixture.versions[0].id}`;
    assert.equal((await fetch(`${server.origin}${path}`)).status, 401);
    const response = await fetch(`${server.origin}${path}`, { headers: auth(student) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-sendfile'), encodeURI(join(root, 'objects', fixture.versions[0].id)));
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.match(response.headers.get('cache-control'), /private/);
  });

  await t.test('reprise ambiguë sur le lien courant refusée', async () => {
    const response = await fetch(`${server.origin}/download/${fixture.resourceId}`, { headers: {
      ...auth(student), Range: 'bytes=100-',
    }, redirect: 'manual' });
    assert.equal(response.status, 400);
  });

  await t.test('chemins internes et métadonnées tus non publiés', async () => {
    for (const path of ['/objects/' + fixture.versions[0].id, '/incoming/', '/private/identities.json']) {
      assert.equal((await fetch(`${server.origin}${path}`, { headers: auth(student) })).status, 404);
    }
  });

  await t.test('perte du marqueur détectée par la sonde', async () => {
    await writeFile(join(root, '.phase0-volume'), 'volume-absent');
    assert.equal((await fetch(`${server.origin}/health/ready`)).status, 503);
    await writeFile(join(root, '.phase0-volume'), fixture.marker);
  });

  await t.test('objet publié symbolique refusé', { skip: process.platform === 'win32' ? 'Validation des symlinks Linux réservée au banc Debian.' : false }, async () => {
    const path = join(root, 'objects', fixture.versions[1].id);
    await unlink(path);
    await symlink(join(root, 'private', 'identities.json'), path);
    const response = await fetch(`${server.origin}/download/${fixture.resourceId}/versions/${fixture.versions[1].id}`, { headers: auth(student) });
    assert.equal(response.status, 404);
  });
});
