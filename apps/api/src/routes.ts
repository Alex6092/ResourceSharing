import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../../packages/core/src/config.ts';
import { Identity, type Actor, type Capability } from '../../../packages/core/src/identity.ts';
import { Catalog, ownership, audit } from '../../../packages/core/src/catalog.ts';
import type { Uploads } from '../../../packages/core/src/uploads.ts';
import { token, sha256, verifyRequest } from '../../../packages/core/src/security.ts';
import { insist } from '../../../packages/core/src/errors.ts';
import { randomUUID } from 'node:crypto';

const ids = z.object({ id: z.uuid() });
const revision = z.object({ revision: z.number().int().positive() });
const folderId = z.union([z.uuid(), z.literal('root')]);
const listing = z.object({ q: z.string().max(200).default(''), folderId: folderId.optional(),
  trash: z.enum(['true', 'false']).default('false'), page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50), sort: z.enum(['name', 'size', 'date', 'type']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc') });
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function linkFor(resource: Record<string, unknown>) {
  const size = Number(resource.sizeBytes || 0);
  const displaySize = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(size / (size >= 1e9 ? 1e9 : size >= 1e6 ? 1e6 : 1e3));
  const label = `📥 Télécharger ${resource.name} — ${displaySize} ${size >= 1e9 ? 'Go' : size >= 1e6 ? 'Mo' : 'Ko'}`;
  return { url: resource.downloadUrl, label, html: `<a href="${escapeHtml(String(resource.downloadUrl))}">${escapeHtml(label)}</a>` };
}

export async function registerRoutes(app: FastifyInstance, pool: Pool, config: Config, identity: Identity, catalog: Catalog, uploads: Uploads) {
  type Options = { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType; cap?: Capability; scope?: string };
  const register = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, options: Options,
    handler: (request: FastifyRequest, reply: FastifyReply, actor: Actor, input: any, query: any, params: any) => unknown) => {
    const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'draft-7' });
    app.route({ method, url, schema: {
      tags: ['Catalogue'], security: [{ session: [] }, { bearerAuth: [] }],
      ...(options.body ? { body: json(options.body) } : {}),
      ...(options.query ? { querystring: json(options.query) } : {}),
      ...(options.params ? { params: json(options.params) } : {}),
    }, handler: async (request, reply) => {
      const actor = await identity.authenticate(request, { mutate: method !== 'GET', cap: options.cap || 'access', scope: options.scope });
      if (actor.kind === 'service') await audit(pool, actor, 'api.read', null, 'success', request.id);
      return handler(request, reply, actor, options.body?.parse(request.body), options.query?.parse(request.query), options.params?.parse(request.params));
    } });
  };
  register('GET', '/api/v1/resources', { query: listing, scope: 'resources:read' }, (_req, _reply, actor, _body, query) => catalog.list(actor, query));
  register('GET', '/api/v1/resources/:id', { params: ids, scope: 'resources:read' }, (_req, _reply, actor, _body, _query, params) => catalog.get(params.id, actor));
  register('GET', '/api/v1/resources/:id/availability', { params: ids, scope: 'availability:read' }, async (_req, _reply, actor, _body, _query, params) => {
    await catalog.get(params.id, actor); return catalog.availability(params.id);
  });
  register('GET', '/api/v1/resources/:id/link', { params: ids, scope: 'resources:read' }, async (_req, _reply, actor, _body, _query, params) => linkFor(await catalog.get(params.id, actor)));
  register('PATCH', '/api/v1/resources/:id', { params: ids, cap: 'upload', body: z.strictObject({
    revision: z.number().int().positive(), name: z.string().min(1).max(255).optional(), folderId: z.uuid().nullable().optional(),
  }) }, (_req, _reply, actor, body, _query, params) => catalog.updateResource(actor, params.id, body));
  register('DELETE', '/api/v1/resources/:id', { params: ids, cap: 'upload', body: revision }, (_req, _reply, actor, body, _query, params) => catalog.updateResource(actor, params.id, { revision: body.revision, trash: true }));
  register('POST', '/api/v1/resources/:id/restore', { params: ids, cap: 'upload', body: revision }, (_req, _reply, actor, body, _query, params) => catalog.updateResource(actor, params.id, { revision: body.revision, restore: true }));
  register('GET', '/api/v1/resources/:id/versions', { params: ids }, async (_req, _reply, actor, _body, _query, params) => {
    const resource = await catalog.get(params.id, actor); ownership(actor, String(resource.ownerId));
    return { items: (await pool.query(`SELECT id,number,size_bytes::text AS "sizeBytes",sha256,created_at AS "createdAt",purged_at AS "purgedAt" FROM resource_versions WHERE resource_id=$1 ORDER BY number DESC`, [params.id])).rows };
  });
  register('POST', '/api/v1/resources/:id/versions/:versionId/restore', { params: ids.extend({ versionId: z.uuid() }), cap: 'upload', body: revision },
    (_req, _reply, actor, body, _query, params) => catalog.updateResource(actor, params.id, { revision: body.revision, versionId: params.versionId }));
  register('GET', '/api/v1/resources/:id/usages', { params: ids }, async (_req, _reply, actor, _body, _query, params) => {
    const resource = await catalog.get(params.id, actor); ownership(actor, String(resource.ownerId));
    return { exhaustive: false, items: (await pool.query('SELECT moodle_context::text AS "contextId",selected_at AS "selectedAt" FROM resource_usages WHERE resource_id=$1 ORDER BY selected_at DESC', [params.id])).rows };
  });
  register('GET', '/api/v1/folders', { query: z.object({ parentId: folderId.optional(), q: z.string().max(200).default('') }), scope: 'folders:read' },
    (_req, _reply, _actor, _body, query) => catalog.folders(query.parentId, query.q));
  register('POST', '/api/v1/folders', { cap: 'upload', body: z.strictObject({ name: z.string().min(1).max(255), parentId: z.uuid().nullable().default(null) }) },
    (_req, reply, actor, body) => { reply.code(201); return catalog.createFolder(actor, body.parentId, body.name); });
  register('PATCH', '/api/v1/folders/:id', { params: ids, cap: 'upload', body: z.strictObject({ name: z.string().min(1).max(255), parentId: z.uuid().nullable(), revision: z.number().int().positive() }) },
    (_req, _reply, actor, body, _query, params) => catalog.updateFolder(actor, params.id, body.revision, body.name, body.parentId));
  register('DELETE', '/api/v1/folders/:id', { params: ids, cap: 'upload', body: revision }, async (_req, reply, actor, body, _query, params) => {
    await catalog.deleteFolder(actor, params.id, body.revision); return reply.code(204).send();
  });
  register('GET', '/api/v1/uploads', {}, (_req, _reply, actor) => uploads.list(actor));
  register('GET', '/api/v1/uploads/:id', { params: ids }, async (_req, _reply, actor, _body, _query, params) => uploads.dto(await uploads.get(params.id, actor)));
  register('POST', '/api/v1/uploads', { cap: 'upload', body: z.strictObject({
    name: z.string().min(1).max(255), sizeBytes: z.string().regex(/^\d{1,16}$/), fingerprint: z.string().min(1).max(512),
    folderId: z.uuid().nullable().default(null), replaceResourceId: z.uuid().optional(), revision: z.number().int().positive().optional(),
  }) }, (_req, reply, actor, body) => { reply.code(201); return uploads.create(actor, body); });
  register('POST', '/api/v1/uploads/:id/finalize', { params: ids, cap: 'upload', body: z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }) },
    (_req, reply, actor, body, _query, params) => { reply.code(202); return uploads.finalize(actor, params.id, body.sha256); });
  register('DELETE', '/api/v1/uploads/:id', { params: ids, cap: 'upload' }, async (_req, reply, actor, _body, _query, params) => {
    await uploads.cancel(actor, params.id); return reply.code(204).send();
  });
  register('GET', '/api/v1/storage', {}, async () => {
    const space = await catalog.storage.space();
    const reserved = BigInt((await pool.query('SELECT coalesce(sum(size_bytes-received_bytes),0)::text AS reserved FROM uploads WHERE state=ANY($1)', [['reserved', 'uploading', 'received', 'verifying', 'publishing']])).rows[0].reserved);
    return { totalBytes: String(space.total), freeBytes: String(space.free), reservedBytes: String(reserved),
      usedBytes: String(space.total - space.free), availableBytes: String(space.free > reserved + space.margin ? space.free - reserved - space.margin : 0n) };
  });
  register('GET', '/api/v1/service-accounts', { cap: 'admin' }, async () => ({ items: (await pool.query('SELECT id,name,scopes,expires_at AS "expiresAt",revoked_at AS "revokedAt" FROM service_accounts ORDER BY created_at DESC')).rows }));
  register('POST', '/api/v1/service-accounts', { cap: 'admin', body: z.strictObject({
    name: z.string().min(1).max(100), scopes: z.array(z.enum(['resources:read', 'folders:read', 'availability:read'])).min(1),
    days: z.number().int().min(1).max(365).default(90),
  }) }, async (_req, reply, actor, body) => {
    const raw = token(), id = randomUUID();
    await pool.query('INSERT INTO service_accounts(id,name,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,now()+$5*interval \'1 day\')', [id, body.name, sha256(raw), body.scopes, body.days]);
    await audit(pool, actor, 'service.create', id); reply.code(201).header('Cache-Control', 'no-store'); return { id, token: raw };
  });
  register('DELETE', '/api/v1/service-accounts/:id', { cap: 'admin', params: ids }, async (_req, reply, actor, _body, _query, params) => {
    await pool.query('UPDATE service_accounts SET revoked_at=now() WHERE id=$1', [params.id]);
    await audit(pool, actor, 'service.revoke', params.id); return reply.code(204).send();
  });
  register('GET', '/api/v1/audit', { cap: 'admin' }, async () => ({ items: (await pool.query('SELECT id::text,action,target_id AS "targetId",result,occurred_at AS "occurredAt" FROM audit_events ORDER BY id DESC LIMIT 200')).rows }));
  register('GET', '/api/v1/statistics', { cap: 'admin' }, async () => ({
    note: 'Les requêtes et les octets ne représentent pas un nombre garanti de téléchargements complets.',
    items: (await pool.query('SELECT day,resource_id AS "resourceId",requests::text,bytes_sent::text AS "bytesSent",errors::text FROM download_aggregates ORDER BY day DESC LIMIT 500')).rows,
  }));
  register('GET', '/api/v1/openapi', { scope: 'resources:read' }, async () => app.swagger());

  app.post('/api/v1/integrations/moodle/catalogue', async (request) => {
    await verifyRequest(pool, config.MOODLE_CATALOG_SECRET, config.MOODLE_CLIENT_ID, config.MOODLE_KEY_ID,
      '/api/v1/integrations/moodle/catalogue', request.rawBody || '', request.headers);
    const body = z.strictObject({ subject: z.string().regex(/^[1-9]\d{0,14}$/), action: z.enum(['list', 'folders', 'get', 'link', 'usage']),
      resourceId: z.uuid().optional(), contextId: z.string().regex(/^\d+$/).optional(), query: z.record(z.string(), z.unknown()).default({}) }).parse(request.body);
    const actor = await identity.subject(body.subject);
    insist(actor.capabilities.includes('access') || actor.capabilities.includes('admin'), 403, 'FORBIDDEN', 'Catalogue réservé aux enseignants autorisés.');
    if (body.action === 'list') return catalog.list(actor, listing.parse(body.query));
    if (body.action === 'folders') return catalog.folders(z.object({ parentId: folderId.optional() }).parse(body.query).parentId);
    insist(body.resourceId, 400, 'INVALID_RESOURCE', 'Ressource requise.');
    const resource = await catalog.get(body.resourceId, actor);
    insist((await catalog.availability(body.resourceId)).available, 409, 'UNAVAILABLE', 'Cette ressource n’est pas disponible.');
    if (body.action === 'get') return resource;
    if (body.action === 'usage') {
      insist(body.contextId, 400, 'INVALID_CONTEXT', 'Contexte requis.');
      await pool.query(`INSERT INTO resource_usages(resource_id,moodle_context,selected_by) VALUES($1,$2,$3)
        ON CONFLICT(resource_id,moodle_context,selected_by) DO UPDATE SET selected_at=now()`, [body.resourceId, body.contextId, actor.id]);
    }
    return linkFor(resource);
  });
}
