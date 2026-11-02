import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { open, lstat, unlink } from 'node:fs/promises';
import { Upload } from '@tus/server';
import { FileStore } from '@tus/file-store';
import type { PgBoss } from 'pg-boss';
import type { Actor } from './identity.ts';
import { activeStates, audit, ownership, userActor, assertNameFree } from './catalog.ts';
import { insist, fileName } from './errors.ts';
import { transaction, lockKey } from './db.ts';
import type { Config } from './config.ts';
import { Storage } from './storage.ts';
import { PgLocker } from './locks.ts';
import { inTransaction } from './queue.ts';
import type { Readable } from 'node:stream';

class CheckedFileStore extends FileStore {
  pool: Pool;
  storage: Storage;
  constructor(pool: Pool, storage: Storage, directory: string) { super({ directory }); this.pool = pool; this.storage = storage; }
  override async write(readable: Readable, id: string, offset: number) {
    // Exécuté sous le verrou tus, et non uniquement avant son acquisition.
    const result = await this.pool.query('SELECT state,expected_sha256 FROM uploads WHERE id=$1', [id]);
    const row = result.rows[0];
    if (!row || !['uploading', 'received'].includes(row.state) || row.expected_sha256) {
      throw { status_code: 409, body: 'Ce transfert ne peut plus être modifié.' };
    }
    await this.storage.ready();
    await this.storage.regular('incoming', id);
    return super.write(readable, id, offset);
  }
}

export class Uploads {
  pool: Pool; config: Config; storage: Storage; store: FileStore; locker: PgLocker; boss: PgBoss;
  constructor(pool: Pool, config: Config, storage: Storage, boss: PgBoss) {
    this.pool = pool; this.config = config; this.storage = storage; this.boss = boss;
    this.store = new CheckedFileStore(pool, storage, `${config.STORAGE_ROOT}/incoming`);
    this.locker = new PgLocker(pool);
  }
  dto(row: Record<string, unknown>) {
    return {
      id: row.id, resourceId: row.resource_id, name: row.name, sizeBytes: String(row.size_bytes),
      receivedBytes: String(row.received_bytes), fingerprint: row.fingerprint,
      state: row.state, errorCode: row.error_code, updatedAt: row.updated_at,
      uploadUrl: `${this.config.APP_ORIGIN}/tus/uploads/${row.id}`,
    };
  }
  async get(id: string, actor?: Actor) {
    const result = await this.pool.query('SELECT u.*,r.name FROM uploads u JOIN resources r ON r.id=u.resource_id WHERE u.id=$1', [id]);
    insist(result.rowCount, 404, 'UPLOAD_NOT_FOUND', 'Transfert introuvable.');
    if (actor) ownership(actor, result.rows[0].owner_id);
    return result.rows[0];
  }
  async list(actor: Actor) {
    userActor(actor);
    const result = await this.pool.query(`SELECT u.*,r.name FROM uploads u JOIN resources r ON r.id=u.resource_id
      WHERE u.owner_id=$1 AND u.created_at>now()-interval '30 days' ORDER BY u.created_at DESC LIMIT 200`, [actor.id]);
    return { items: result.rows.map((row) => this.dto(row)) };
  }
  async create(actor: Actor, input: { name: string; sizeBytes: string; folderId: string | null; fingerprint: string; replaceResourceId?: string; revision?: number }) {
    userActor(actor);
    const size = BigInt(input.sizeBytes);
    insist(size >= 0n && size <= BigInt(Number.MAX_SAFE_INTEGER), 400, 'INVALID_SIZE', 'Taille non prise en charge.');
    const name = fileName(input.name), id = randomUUID(), versionId = randomUUID();
    await transaction(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey('mprovi:space')]);
      await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey('mprovi:tree')]);
      const space = await this.storage.space();
      const counts = (await db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE owner_id=$1)::int AS own,
        coalesce(sum(size_bytes-received_bytes),0)::text AS reserved FROM uploads WHERE state=ANY($2)`, [actor.id, activeStates])).rows[0];
      insist(counts.total < this.config.MAX_ACTIVE_UPLOADS && counts.own < this.config.MAX_USER_UPLOADS,
        429, 'UPLOAD_QUEUE_FULL', 'La limite de transferts actifs est atteinte. Terminez ou annulez un dépôt, puis réessayez.');
      insist(space.free - BigInt(counts.reserved) - size >= space.margin, 507, 'INSUFFICIENT_STORAGE', 'L’espace disponible ne permet pas ce dépôt.');
      let resourceId = input.replaceResourceId;
      let baseVersionId = null;
      if (resourceId) {
        const row = (await db.query('SELECT * FROM resources WHERE id=$1 FOR UPDATE', [resourceId])).rows[0];
        insist(row && ['ready', 'missing'].includes(row.state), 404, 'NOT_FOUND', 'Ressource à remplacer introuvable.');
        ownership(actor, row.owner_id);
        insist(row.revision === input.revision, 409, 'REVISION_CONFLICT', 'La ressource a changé.');
        baseVersionId = row.current_version_id;
      } else {
        resourceId = randomUUID();
        if (input.folderId) insist((await db.query('SELECT id FROM folders WHERE id=$1', [input.folderId])).rowCount, 404, 'NOT_FOUND', 'Dossier introuvable.');
        await assertNameFree(db, input.folderId, name);
        await db.query('INSERT INTO resources(id,folder_id,owner_id,name) VALUES($1,$2,$3,$4)', [resourceId, input.folderId, actor.id, name]);
        await db.query('INSERT INTO download_links(resource_id) VALUES($1)', [resourceId]);
      }
      await db.query(`INSERT INTO uploads(id,resource_id,owner_id,base_version_id,version_id,size_bytes,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, resourceId, actor.id, baseVersionId, versionId, input.sizeBytes, input.fingerprint]);
      await audit(db, actor, input.replaceResourceId ? 'upload.replace.begin' : 'upload.begin', id);
    });
    await this.initialize(id);
    return this.dto(await this.get(id, actor));
  }
  async initialize(id: string) {
    await this.locker.using(id, async () => {
      const row = await this.get(id);
      if (row.state !== 'reserved') return;
      await this.storage.ready();
      const path = this.storage.path('incoming', id);
      try {
        const file = await open(path, 'wx', 0o600);
        await file.close();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await this.storage.regular('incoming', id);
      await this.store.configstore.set(id, new Upload({ id, size: Number(row.size_bytes), offset: 0, metadata: {} }));
      await this.pool.query("UPDATE uploads SET state='uploading',updated_at=now() WHERE id=$1 AND state='reserved'", [id]);
    });
  }
  async refresh(id: string) {
    const row = await this.get(id);
    if (!['uploading', 'received'].includes(row.state)) return;
    const { info } = await this.storage.regular('incoming', id);
    insist(BigInt(info.size) <= BigInt(row.size_bytes), 409, 'SIZE_MISMATCH', 'Le fichier dépasse la taille annoncée.');
    await this.pool.query(`UPDATE uploads SET received_bytes=$2,state=CASE WHEN size_bytes=$2 THEN 'received' ELSE 'uploading' END,
      updated_at=now(),last_activity_at=now() WHERE id=$1 AND state IN ('uploading','received')`, [id, String(info.size)]);
  }
  async finalize(actor: Actor, id: string, expectedSha256: string) {
    const row = await this.get(id, actor);
    if (row.state === 'completed') return this.dto(row);
    await this.locker.using(id, async () => {
      await this.storage.ready();
      const current = await this.get(id, actor);
      insist(['uploading', 'received', 'verifying', 'publishing'].includes(current.state), 409, 'UPLOAD_CLOSED', 'Ce dépôt est fermé.');
      if (['verifying', 'publishing'].includes(current.state)) {
        insist(current.expected_sha256 === expectedSha256, 409, 'HASH_CHANGED', 'L’empreinte de validation ne peut plus être changée.');
        return;
      }
      const { info } = await this.storage.regular('incoming', id);
      insist(BigInt(info.size) === BigInt(current.size_bytes), 409, 'UPLOAD_INCOMPLETE', 'Le transfert n’est pas terminé.');
      await transaction(this.pool, async (db) => {
        await db.query(`UPDATE uploads SET expected_sha256=$2,received_bytes=size_bytes,state='received',updated_at=now(),last_activity_at=now() WHERE id=$1`, [id, expectedSha256]);
        await this.boss.send('validate-upload', { id }, { db: inTransaction(db), singletonKey: id });
        await audit(db, actor, 'upload.finalize', id);
      });
    });
    return this.dto(await this.get(id, actor));
  }
  async cancel(actor: Actor | null, id: string, expired = false) {
    await this.get(id, actor || undefined);
    await this.locker.using(id, async () => {
      await this.storage.ready();
      const row = await this.get(id, actor || undefined);
      insist(!['completed', 'publishing'].includes(row.state), 409, 'UPLOAD_CLOSED', 'Le dépôt est déjà publié ou en cours de publication.');
      if (['cancelled', 'expired'].includes(row.state)) return;
      const path = this.storage.path('incoming', id);
      try { await this.storage.regular('incoming', id); await unlink(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.store.configstore.delete(id);
      await transaction(this.pool, async (db) => {
        await db.query("UPDATE uploads SET state=$2,updated_at=now() WHERE id=$1", [id, expired ? 'expired' : 'cancelled']);
        await db.query("UPDATE resources SET state='trashed',deleted_at=now(),folder_id=NULL,revision=revision+1 WHERE id=$1 AND state='draft'", [row.resource_id]);
        await audit(db, actor, expired ? 'upload.expire' : 'upload.cancel', id);
      });
    });
  }
}
