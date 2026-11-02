// Banc isolé de phase 0 : identités fictives, aucune connexion à Moodle.
// Ne pas réutiliser ses routes ou ses jetons comme authentification applicative.
import Fastify from 'fastify';
import { Server, MemoryLocker } from '@tus/server';
import { FileStore } from '@tus/file-store';
import pg from 'pg';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile, lstat, realpath, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { PgLocker } from './pg-locker.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = (value) => createHash('sha256').update(value).digest();
const failure = (status_code, body) => ({ status_code, body });

export async function buildServer({ root, marker, publicOrigin, databaseUrl, port = 0 }) {
  root = resolve(root);
  const roots = Object.fromEntries(['incoming', 'objects', 'quarantine'].map((name) => [name, join(root, name)]));
  if ((await readFile(join(root, '.phase0-volume'), 'utf8')) !== marker) {
    throw new Error('Marqueur du volume incorrect.');
  }
  const volume = await stat(root);
  for (const path of Object.values(roots)) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== volume.dev) {
      throw new Error('Stockage invalide : répertoires réels sur un même volume requis.');
    }
  }
  const identities = JSON.parse(await readFile(join(root, 'private', 'identities.json'), 'utf8'));
  const credentials = identities.map(({ token, ...identity }) => ({ ...identity, hash: digest(token) }));
  function authenticate(header) {
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) {
      throw failure(401, 'Authentification de test requise.');
    }
    const hash = digest(header.slice(7));
    const identity = credentials.find((candidate) => timingSafeEqual(candidate.hash, hash));
    if (!identity) throw failure(401, 'Authentification de test invalide.');
    return identity;
  }
  const pool = databaseUrl ? new pg.Pool({
    connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3000,
    query_timeout: 3000, application_name: 'mprovi-phase0',
  }) : undefined;
  if (pool) await pool.query('SELECT 1');
  const locker = pool ? new PgLocker(pool) : new MemoryLocker({ acquireLockTimeout: 3000 });
  const store = new FileStore({ directory: roots.incoming });
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024, requestTimeout: 0 });
  app.server.setTimeout(300000);
  let origin = publicOrigin;
  const tus = new Server({
    path: '/tus/uploads', datastore: store, locker,
    disableTerminationForFinishedUploads: true,
    namingFunction: () => randomUUID(),
    generateUrl: (_request, { id }) => `${origin}/tus/uploads/${id}`,
    onIncomingRequest: async (request, id) => {
      if (request.method === 'GET') throw failure(405, 'Aucun téléchargement par tus.');
      const identity = authenticate(request.headers.get('authorization'));
      if (!identity.canUpload) throw failure(403, 'Dépôt interdit.');
      if (request.headers.has('origin') && request.headers.get('origin') !== origin) {
        throw failure(403, 'Origine refusée.');
      }
      if (request.method === 'PATCH') {
        const length = request.headers.get('content-length');
        if (!length || !/^\d+$/.test(length)) throw failure(411, 'Taille de bloc requise.');
        if (Number(length) > 32 * 1024 * 1024) throw failure(413, 'Bloc trop volumineux.');
      }
      if (request.method === 'POST' && Number(request.headers.get('content-length') || 0) !== 0) {
        throw failure(400, 'Créer le transfert avant de transmettre les blocs.');
      }
      if (request.method === 'POST' && new URL(request.url).pathname !== '/tus/uploads') {
        throw failure(405, 'Créer un transfert sur la collection.');
      }
      if (id && request.method !== 'POST') {
        if (!uuid.test(id)) throw failure(404, 'Transfert inconnu.');
        const file = await store.getUpload(id);
        if (file.metadata?.owner !== identity.id) throw failure(403, 'Ce transfert appartient à un autre utilisateur.');
        const info = await lstat(join(roots.incoming, id));
        if (info.isSymbolicLink() || !info.isFile()) throw failure(404, 'Transfert invalide.');
      }
    },
    onUploadCreate: async (request, upload) => {
      const identity = authenticate(request.headers.get('authorization'));
      if (!Number.isSafeInteger(upload.size) || upload.size < 0) throw failure(400, 'Taille connue requise.');
      return { metadata: { owner: identity.id } };
    },
  });
  app.addContentTypeParser('application/offset+octet-stream', (_request, _payload, done) => done(null));
  app.route({
    method: ['OPTIONS', 'POST', 'HEAD', 'PATCH', 'DELETE', 'GET'],
    url: '/tus/uploads', handler: handleTus,
  });
  app.route({
    method: ['OPTIONS', 'POST', 'HEAD', 'PATCH', 'DELETE', 'GET'],
    url: '/tus/uploads/*', handler: handleTus,
  });
  async function handleTus(request, reply) {
    reply.hijack();
    await tus.handle(request.raw, reply.raw);
  }
  app.get('/health/ready', async () => {
    if ((await readFile(join(root, '.phase0-volume'), 'utf8')) !== marker) throw failure(503, 'Volume absent.');
    if (pool) await pool.query('SELECT 1');
    return { mode: 'phase0-fixture-only', postgres: Boolean(pool), downloadStrategy: 'apache-xsendfile' };
  });
  async function downloadIdentity(request) {
    return authenticate(request.headers.authorization);
  }
  app.get('/download/:id', async (request, reply) => {
    await downloadIdentity(request);
    const fixture = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8'));
    if (request.params.id !== fixture.resourceId) throw failure(404, 'Ressource inconnue.');
    if (request.headers.range && !request.headers['if-range']) {
      throw failure(400, 'Utilisez une URL de version ou If-Range pour reprendre.');
    }
    return reply.header('Cache-Control', 'no-store').redirect(
      `${origin}/download/${fixture.resourceId}/versions/${fixture.currentVersionId}`, 302,
    );
  });
  app.get('/download/:id/versions/:version', async (request, reply) => {
    await downloadIdentity(request);
    const fixture = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8'));
    const version = fixture.versions.find((candidate) => candidate.id === request.params.version);
    if (request.params.id !== fixture.resourceId || !version || !uuid.test(version.id)) throw failure(404, 'Version inconnue.');
    const path = join(roots.objects, version.id);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw failure(404, 'Objet indisponible.');
    const rel = relative(await realpath(roots.objects), await realpath(path));
    if (isAbsolute(rel) || rel.startsWith('..')) throw failure(404, 'Objet invalide.');
    return reply
      .header('X-Sendfile', encodeURI(path))
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="debian-ecole.ova"; filename*=UTF-8''debian-%C3%A9cole.ova`)
      .header('Cache-Control', 'private, no-cache, max-age=0, must-revalidate')
      .header('ETag', `"${version.sha256}"`)
      .header('Accept-Ranges', 'bytes')
      .header('X-Content-Type-Options', 'nosniff')
      .send(); // Aucune lecture du contenu, même si Apache est mal configuré.
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error.status_code || error.statusCode || 500;
    reply.code(status).header('Cache-Control', 'no-store').send({
      code: `PHASE0_${status}`, message: error.body || 'Erreur du banc de validation.',
    });
  });
  app.addHook('onClose', async () => { if (pool) await pool.end(); });
  await app.listen({ host: '127.0.0.1', port });
  origin ||= `http://127.0.0.1:${app.server.address().port}`;
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.env.PHASE0_FIXTURE_ONLY !== '1') throw new Error('Démarrage réservé au banc de phase 0.');
  const root = process.env.PHASE0_ROOT;
  if (!root || !process.env.PHASE0_MARKER) throw new Error('Configuration de test absente.');
  const app = await buildServer({
    root, marker: process.env.PHASE0_MARKER, publicOrigin: process.env.PHASE0_PUBLIC_ORIGIN,
    databaseUrl: process.env.PHASE0_DATABASE_URL, port: Number(process.env.PHASE0_PORT || 0),
  });
  process.stdout.write(`${JSON.stringify({ ready: true, port: app.server.address().port, pid: process.pid })}\n`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
