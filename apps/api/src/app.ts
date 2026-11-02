import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import { Server } from '@tus/server';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import type { Config } from '../../../packages/core/src/config.ts';
import { Identity } from '../../../packages/core/src/identity.ts';
import { Storage } from '../../../packages/core/src/storage.ts';
import { Catalog } from '../../../packages/core/src/catalog.ts';
import { Uploads } from '../../../packages/core/src/uploads.ts';
import { insist, HttpError } from '../../../packages/core/src/errors.ts';
import { registerAuth } from './auth.ts';
import { registerRoutes } from './routes.ts';
import { randomUUID } from 'node:crypto';
import { requestContext } from '../../../packages/core/src/request-context.ts';
import { audit } from '../../../packages/core/src/catalog.ts';

declare module 'fastify' { interface FastifyRequest { rawBody?: string } }

export async function buildApp(config: Config, pool: Pool, boss: PgBoss) {
  const storage = new Storage(config);
  await storage.ready();
  const identity = new Identity(config, pool), catalog = new Catalog(pool, config, storage);
  const uploads = new Uploads(pool, config, storage, boss);
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), bodyLimit: 1024 * 1024, requestTimeout: 0 });
  app.addHook('onRequest', (request, _reply, done) => { requestContext.run(request.id, done); });
  app.server.headersTimeout = 30000;
  app.server.setTimeout(300000);
  await app.register(cookie);
  await app.register(swagger, { openapi: {
    info: { title: 'MProviFileSharing', version: '0.1.0', description: 'Catalogue pédagogique. Les transferts volumineux sont délégués à Apache.' },
    servers: [{ url: config.APP_ORIGIN }],
    components: { securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'Compte technique à portées limitées.' },
      session: { type: 'apiKey', in: 'cookie', name: config.cookieName },
    } },
  } });
  app.decorateRequest('rawBody', undefined);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = String(body);
    try { done(null, JSON.parse(String(body))); }
    catch { done(new HttpError(400, 'INVALID_JSON', 'Le corps JSON est invalide.')); }
  });
  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
  });
  app.setErrorHandler(async (error, request, reply) => {
    const e = error as Error & { code?: string; statusCode?: number; validation?: unknown };
    let status = e.statusCode || 500, code = e.code || 'INTERNAL_ERROR';
    let message = error instanceof HttpError ? error.message : 'Une erreur est survenue. Réessayez ou contactez un administrateur.';
    if (error instanceof z.ZodError || e.validation) { status = 400; code = 'INVALID_INPUT'; message = 'Les paramètres fournis sont invalides.'; }
    if (e.code === '23505') { status = 409; code = 'NAME_CONFLICT'; message = 'Un élément du même nom ou un remplacement en cours existe déjà. Renommez le fichier ou choisissez explicitement Remplacer.'; }
    if (e.code === '23503') { status = 409; code = 'REFERENCE_CONFLICT'; message = 'Cet élément est encore utilisé. Rechargez la liste.'; }
    if (e.code === 'ENOSPC') { status = 507; code = 'INSUFFICIENT_STORAGE'; message = 'Le volume de ressources est plein.'; }
    if (status >= 500) console.error(JSON.stringify({ requestId: request.id, code, status }));
    if (request.url.split('?')[0] === '/auth/moodle/callback') await audit(pool, null, 'login', null, code, request.id).catch(() => {});
    else if (['CSRF', 'NOT_OWNER', 'FORBIDDEN', 'ACCOUNT_DISABLED'].includes(code)) await audit(pool, null, 'access.denied', null, code, request.id).catch(() => {});
    reply.code(status).header('Cache-Control', 'no-store').send({ code, message, requestId: request.id });
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/api/public-config', async () => ({ moodleUrl: config.MOODLE_ORIGIN, maxParallelUploads: config.MAX_USER_UPLOADS }));
  app.get('/health/ready', async () => { await storage.ready(); await pool.query('SELECT 1'); return { status: 'ready' }; });
  await registerAuth(app, pool, config, identity);
  await registerRoutes(app, pool, config, identity, catalog, uploads);

  const tus = new Server({ path: '/tus/uploads', datastore: uploads.store, locker: uploads.locker,
    disableTerminationForFinishedUploads: true,
    generateUrl: (_request, { id }) => `${config.APP_ORIGIN}/tus/uploads/${id}`,
    onIncomingRequest: async (request, id) => {
      const nodeRequest = request.runtime?.node?.req;
      const original = nodeRequest && activeRequests.get(nodeRequest);
      if (!original) throw { status_code: 401, body: 'Session requise.' };
      // La création passe exclusivement par POST /api/v1/uploads ; le serveur
      // tus n'est jamais autorisé à réinitialiser un fichier existant.
      if (!['HEAD', 'PATCH', 'OPTIONS'].includes(request.method)) throw { status_code: 405, body: 'Méthode non autorisée.' };
      const actor = await identity.authenticate(original, { fresh: true, mutate: request.method === 'PATCH', cap: 'upload' });
      const row = await uploads.get(z.uuid().parse(id));
      insist(actor.kind === 'user' && actor.id === row.owner_id, 403, 'NOT_OWNER', 'Ce transfert appartient à un autre utilisateur.');
      insist(['uploading', 'received'].includes(row.state) && !row.expected_sha256, 409, 'UPLOAD_CLOSED', 'Ce dépôt est fermé ou en validation.');
      if (request.method === 'PATCH') {
        const length = request.headers.get('content-length');
        insist(length && /^\d+$/.test(length), 411, 'LENGTH_REQUIRED', 'La taille du bloc est requise.');
        insist(Number(length) <= 32 * 1024 * 1024, 413, 'CHUNK_TOO_LARGE', 'Bloc de transfert trop volumineux.');
      }
      await storage.ready();
      await storage.regular('incoming', id);
    },
    onResponseError: (_req, error) => error instanceof HttpError ? { status_code: error.statusCode, body: error.message } : undefined,
  });
  const activeRequests = new WeakMap<object, import('fastify').FastifyRequest>();
  app.addContentTypeParser('application/offset+octet-stream', (_request, _payload, done) => done(null));
  app.route({ method: ['HEAD', 'PATCH'], url: '/tus/uploads/:id', handler: async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    activeRequests.set(request.raw, request);
    reply.hijack();
    try { await tus.handle(request.raw, reply.raw); }
    finally { activeRequests.delete(request.raw); }
    // Le worker reprend aussi cette mise à jour si le processus s'arrête après
    // la réponse HTTP. Aucune ressource n'est publiée par cette notification.
    if (request.method === 'PATCH' && reply.raw.statusCode < 300) {
      await uploads.refresh(id).catch(() => {});
    }
  } });
  app.delete('/tus/uploads/:id', async (request, reply) => {
    const actor = await identity.authenticate(request, { mutate: true, cap: 'upload' });
    await uploads.cancel(actor, z.object({ id: z.uuid() }).parse(request.params).id);
    return reply.header('Tus-Resumable', '1.0.0').code(204).send();
  });
  app.options('/tus/uploads/:id', async (request, reply) => {
    await identity.authenticate(request, { fresh: true, cap: 'upload' });
    const row = await uploads.get(z.object({ id: z.uuid() }).parse(request.params).id);
    const actor = await identity.authenticate(request, { cap: 'upload' });
    insist(actor.kind === 'user' && row.owner_id === actor.id, 403, 'NOT_OWNER', 'Ce transfert appartient à un autre utilisateur.');
    return reply.header('Tus-Resumable', '1.0.0').header('Tus-Version', '1.0.0').header('Tus-Extension', 'termination').code(204).send();
  });

  const downloadIds = z.object({ id: z.uuid(), versionId: z.uuid().optional() });
  const authorizeDownload = async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    try { return await identity.authenticate(request, { fresh: true }); }
    catch (error) {
      if (error instanceof HttpError && error.statusCode === 401) {
        const returnTo = new URL(request.url, config.APP_ORIGIN).pathname;
        reply.header('Cache-Control', 'no-store').redirect(`/auth/moodle/start?purpose=download&returnTo=${encodeURIComponent(returnTo)}`);
        return null;
      }
      throw error;
    }
  };
  app.get('/download/:id', async (request, reply) => {
    const { id } = downloadIds.parse(request.params);
    if (!await authorizeDownload(request, reply)) return reply;
    const row = (await pool.query('SELECT state,current_version_id FROM resources WHERE id=$1', [id])).rows[0];
    insist(row && row.state !== 'draft', 404, 'NOT_FOUND', 'Ressource introuvable.');
    insist(row.state !== 'trashed', 410, 'RESOURCE_DELETED', 'Cette ressource est dans la corbeille. Contactez son enseignant.');
    insist(row.state === 'ready', 503, 'OBJECT_UNAVAILABLE', 'Le fichier est temporairement indisponible.');
    insist(!request.headers.range || request.headers['if-range'], 400, 'AMBIGUOUS_RANGE', 'Reprenez depuis une URL de version ou avec If-Range.');
    return reply.header('Cache-Control', 'no-store').redirect(`${config.APP_ORIGIN}/download/${id}/versions/${row.current_version_id}`, 302);
  });
  app.get('/download/:id/versions/:versionId', async (request, reply) => {
    const { id, versionId } = downloadIds.parse(request.params);
    if (!await authorizeDownload(request, reply)) return reply;
    await storage.ready();
    const resource = (await pool.query('SELECT * FROM resources WHERE id=$1', [id])).rows[0];
    insist(resource && resource.state !== 'draft', 404, 'NOT_FOUND', 'Ressource introuvable.');
    insist(resource.state !== 'trashed', 410, 'RESOURCE_DELETED', 'Cette ressource a été supprimée.');
    const version = (await pool.query('SELECT * FROM resource_versions WHERE resource_id=$1 AND id=$2', [id, versionId])).rows[0];
    insist(version && !version.purged_at, 410, 'VERSION_UNAVAILABLE', 'Cette version n’est plus conservée.');
    let object;
    try { object = await storage.regular('objects', version.id); }
    catch { throw new HttpError(503, 'OBJECT_UNAVAILABLE', 'Le fichier est temporairement indisponible.'); }
    insist(String(object.info.size) === String(version.size_bytes), 503, 'OBJECT_UNAVAILABLE', 'Le fichier nécessite une vérification.');
    const ascii = resource.name.replace(/[^\x20-\x7e]/g, '_');
    const encoded = encodeURIComponent(resource.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return reply.header('X-Sendfile', encodeURI(object.path))
      .header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`)
      .header('Content-Type', 'application/octet-stream').header('ETag', `"${version.sha256}"`)
      .header('Last-Modified', object.info.mtime.toUTCString()).header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'private, no-cache, max-age=0, must-revalidate').send();
  });
  return { app, catalog, uploads, identity, storage };
}
