import type { Pool, PoolClient } from 'pg';
import type { Actor, UserActor } from './identity.ts';
import { has } from './identity.ts';
import { transaction, lockKey } from './db.ts';
import { insist, fileName } from './errors.ts';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Storage } from './storage.ts';

export const resourceSelect = `SELECT r.id,r.folder_id AS "folderId",r.owner_id AS "ownerId",r.name,
  r.state AS availability,r.revision,r.current_version_id AS "currentVersionId",
  r.created_at AS "createdAt",r.updated_at AS "updatedAt",r.deleted_at AS "deletedAt",
  v.size_bytes::text AS "sizeBytes",v.sha256,v.created_at AS "uploadedAt",v.mime_type AS "mimeType",
  u.display_name AS "ownerName",uploader.display_name AS "uploaderName"
  FROM resources r JOIN users u ON u.id=r.owner_id LEFT JOIN resource_versions v ON v.id=r.current_version_id
  LEFT JOIN users uploader ON uploader.id=v.uploader_id`;
export const activeStates = ['reserved', 'uploading', 'received', 'verifying', 'publishing'];

export async function audit(db: Pool | PoolClient, actor: Actor | null, action: string, target: string | null, result = 'success', requestId?: string) {
  await db.query('INSERT INTO audit_events(user_id,service_id,action,target_id,result,request_id) VALUES($1,$2,$3,$4,$5,$6)',
    [actor?.kind === 'user' ? actor.id : null, actor?.kind === 'service' ? actor.id : null, action, target, result, requestId || null]);
}
export function userActor(actor: Actor): asserts actor is UserActor {
  insist(actor.kind === 'user', 403, 'READ_ONLY', 'Un compte technique ne peut pas modifier les ressources.');
}
export function ownership(actor: Actor, ownerId: string) {
  userActor(actor);
  insist(actor.id === ownerId || has(actor, 'manageothers'), 403, 'NOT_OWNER', 'Cette ressource appartient à un autre enseignant.');
}

export class Catalog {
  pool: Pool;
  config: Config;
  storage: Storage;
  constructor(pool: Pool, config: Config, storage: Storage) { this.pool = pool; this.config = config; this.storage = storage; }
  dto(row: Record<string, unknown>): Record<string, unknown> {
    return { ...row, extension: String(row.name).includes('.') ? String(row.name).split('.').at(-1)!.toLowerCase() : '',
      downloadUrl: `${this.config.APP_ORIGIN}/download/${row.id}` };
  }
  async list(actor: Actor, query: { q: string; folderId?: string; trash: string; page: number; limit: number; sort: string; order: string }) {
    const parameters: unknown[] = [query.q];
    let where = "r.state IN ('ready','missing') AND strpos(lower(r.name),lower($1))>0";
    if (query.trash === 'true') {
      userActor(actor);
      parameters.push(actor.id, has(actor, 'manageothers'));
      where = 'r.state=\'trashed\' AND r.current_version_id IS NOT NULL AND (r.owner_id=$2 OR $3) AND strpos(lower(r.name),lower($1))>0';
    }
    if (query.folderId) {
      parameters.push(query.folderId === 'root' ? null : query.folderId);
      where += ` AND r.folder_id IS NOT DISTINCT FROM $${parameters.length}::uuid`;
    }
    const sort = ({ name: 'lower(r.name)', size: 'v.size_bytes', date: 'r.updated_at', type: "lower(substring(r.name from '\\.([^.]+)$'))" } as Record<string, string>)[query.sort];
    parameters.push(query.limit, (query.page - 1) * query.limit);
    const result = await this.pool.query(`${resourceSelect} WHERE ${where} ORDER BY ${sort} ${query.order === 'desc' ? 'DESC' : 'ASC'} NULLS LAST,r.id
      LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`, parameters);
    const count = await this.pool.query(`SELECT count(*)::int AS total FROM resources r LEFT JOIN resource_versions v ON v.id=r.current_version_id WHERE ${where}`, parameters.slice(0, -2));
    return { items: result.rows.map((row) => this.dto(row)), page: query.page, limit: query.limit, total: count.rows[0].total, hasMore: query.page * query.limit < count.rows[0].total };
  }
  async get(id: string, actor?: Actor) {
    const result = await this.pool.query(`${resourceSelect} WHERE r.id=$1`, [id]);
    insist(result.rowCount, 404, 'NOT_FOUND', 'Ressource introuvable.');
    const row = result.rows[0];
    if (row.availability === 'draft') insist(actor?.kind === 'user' && (row.ownerId === actor.id || has(actor, 'manageothers')), 404, 'NOT_FOUND', 'Ressource introuvable.');
    return this.dto(row);
  }
  async availability(id: string) {
    const result = await this.pool.query('SELECT state,current_version_id FROM resources WHERE id=$1', [id]);
    insist(result.rowCount, 404, 'NOT_FOUND', 'Ressource introuvable.');
    const row = result.rows[0];
    let available = row.state === 'ready';
    if (available) {
      await this.storage.ready();
      try { await this.storage.regular('objects', row.current_version_id); } catch { available = false; }
    }
    return { available, state: row.state, currentVersionId: row.current_version_id, checkedAt: new Date().toISOString() };
  }
  async folders(parentId?: string, q = '') {
    const filter = parentId === undefined ? '' : ' AND parent_id IS NOT DISTINCT FROM $2::uuid';
    const result = await this.pool.query(`SELECT id,parent_id AS "parentId",owner_id AS "ownerId",name,revision FROM folders
      WHERE strpos(lower(name),lower($1))>0${filter} ORDER BY lower(name),id`, parentId === undefined ? [q] : [q, parentId === 'root' ? null : parentId]);
    return { items: result.rows };
  }
  async createFolder(actor: Actor, parentId: string | null, name: string) {
    userActor(actor);
    const id = randomUUID();
    return transaction(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey('mprovi:tree')]);
      if (parentId) insist((await db.query('SELECT id FROM folders WHERE id=$1', [parentId])).rowCount, 404, 'NOT_FOUND', 'Dossier parent introuvable.');
      const result = await db.query('INSERT INTO folders(id,parent_id,owner_id,name) VALUES($1,$2,$3,$4) RETURNING id,name,revision', [id, parentId, actor.id, fileName(name)]);
      await audit(db, actor, 'folder.create', id);
      return result.rows[0];
    });
  }
  async updateFolder(actor: Actor, id: string, revision: number, name: string, parentId: string | null) {
    userActor(actor);
    return transaction(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey('mprovi:tree')]);
      const row = (await db.query('SELECT * FROM folders WHERE id=$1 FOR UPDATE', [id])).rows[0];
      insist(row, 404, 'NOT_FOUND', 'Dossier introuvable.');
      ownership(actor, row.owner_id);
      insist(row.revision === revision, 409, 'REVISION_CONFLICT', 'Le dossier a changé. Rechargez la liste.');
      const subtree = await db.query(`WITH RECURSIVE tree AS (SELECT id,owner_id FROM folders WHERE id=$1
        UNION ALL SELECT f.id,f.owner_id FROM folders f JOIN tree t ON f.parent_id=t.id)
        SELECT id,owner_id FROM tree`, [id]);
      const ids = subtree.rows.map((folder) => folder.id);
      insist(!parentId || !ids.includes(parentId), 400, 'FOLDER_CYCLE', 'Un dossier ne peut pas être déplacé dans lui-même.');
      if (parentId) insist((await db.query('SELECT id FROM folders WHERE id=$1', [parentId])).rowCount, 404, 'NOT_FOUND', 'Dossier parent introuvable.');
      if (!has(actor, 'manageothers')) {
        const otherFiles = await db.query('SELECT 1 FROM resources WHERE folder_id=ANY($1::uuid[]) AND owner_id<>$2 LIMIT 1', [ids, actor.id]);
        insist(!otherFiles.rowCount && subtree.rows.every((folder) => folder.owner_id === actor.id), 403, 'SHARED_FOLDER', 'Cette branche contient des éléments d’autres enseignants. Un gestionnaire doit la modifier.');
      }
      const result = await db.query('UPDATE folders SET name=$2,parent_id=$3,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING id,name,revision', [id, fileName(name), parentId]);
      await audit(db, actor, 'folder.update', id);
      return result.rows[0];
    });
  }
  async deleteFolder(actor: Actor, id: string, revision: number) {
    return transaction(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey('mprovi:tree')]);
      const row = (await db.query('SELECT * FROM folders WHERE id=$1 FOR UPDATE', [id])).rows[0];
      insist(row, 404, 'NOT_FOUND', 'Dossier introuvable.');
      ownership(actor, row.owner_id);
      insist(row.revision === revision, 409, 'REVISION_CONFLICT', 'Le dossier a changé.');
      const content = await db.query('SELECT 1 FROM folders WHERE parent_id=$1 UNION ALL SELECT 1 FROM resources WHERE folder_id=$1 LIMIT 1', [id]);
      insist(!content.rowCount, 409, 'FOLDER_NOT_EMPTY', 'Le dossier contient encore des éléments, y compris éventuellement dans la corbeille.');
      await db.query('DELETE FROM folders WHERE id=$1', [id]);
      await audit(db, actor, 'folder.delete', id);
    });
  }
  async updateResource(actor: Actor, id: string, change: { revision: number; name?: string; folderId?: string | null; trash?: boolean; restore?: boolean; versionId?: string }) {
    userActor(actor);
    await transaction(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey('mprovi:tree')]);
      await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey('mprovi:backup-purge')]);
      const row = (await db.query('SELECT * FROM resources WHERE id=$1 FOR UPDATE', [id])).rows[0];
      insist(row, 404, 'NOT_FOUND', 'Ressource introuvable.');
      ownership(actor, row.owner_id);
      insist(row.revision === change.revision, 409, 'REVISION_CONFLICT', 'La ressource a changé. Rechargez la liste.');
      insist(row.state !== 'draft', 409, 'UPLOAD_PENDING', 'Le dépôt n’est pas terminé.');
      if (change.trash) {
        insist(!(await db.query('SELECT 1 FROM uploads WHERE resource_id=$1 AND state=ANY($2) LIMIT 1', [id, activeStates])).rowCount, 409, 'UPLOAD_PENDING', 'Un remplacement est en cours. Annulez-le avant de supprimer.');
        await db.query("UPDATE resources SET state='trashed',deleted_at=now(),revision=revision+1,updated_at=now() WHERE id=$1", [id]);
      } else {
        const versionId = change.versionId || row.current_version_id;
        if (change.restore || change.versionId) {
          insist(!(await db.query('SELECT 1 FROM uploads WHERE resource_id=$1 AND state=ANY($2) LIMIT 1', [id, activeStates])).rowCount,
            409, 'UPLOAD_PENDING', 'Un remplacement est en cours. Annulez-le avant de restaurer une version.');
          await this.storage.ready();
          const version = (await db.query('SELECT * FROM resource_versions WHERE id=$1 AND resource_id=$2 AND purged_at IS NULL', [versionId, id])).rows[0];
          insist(version, 409, 'VERSION_UNAVAILABLE', 'Cette version n’est plus conservée.');
          try { await this.storage.regular('objects', version.id); } catch { insist(false, 409, 'VERSION_UNAVAILABLE', 'Le contenu de cette version est absent.'); }
          await db.query('UPDATE resource_versions SET retired_at=now() WHERE id=$1 AND id<>$2', [row.current_version_id, versionId]);
          await db.query('UPDATE resource_versions SET retired_at=NULL WHERE id=$1', [versionId]);
        } else insist(row.state !== 'trashed', 409, 'RESOURCE_TRASHED', 'Restaurez la ressource avant de la modifier.');
        if (change.folderId) insist((await db.query('SELECT id FROM folders WHERE id=$1', [change.folderId])).rowCount, 404, 'NOT_FOUND', 'Dossier introuvable.');
        await db.query(`UPDATE resources SET name=$2,folder_id=$3,current_version_id=$4,state=$5,
          deleted_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1`,
        [id, change.name === undefined ? row.name : fileName(change.name), change.folderId === undefined ? row.folder_id : change.folderId,
          versionId, change.restore || change.versionId ? 'ready' : row.state]);
      }
      await audit(db, actor, change.trash ? 'resource.trash' : change.restore || change.versionId ? 'resource.restore' : 'resource.update', id);
    });
    return this.get(id, actor);
  }
}
