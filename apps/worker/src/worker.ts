import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import { rename, chmod, open, unlink, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../../../packages/core/src/config.ts';
import { Storage } from '../../../packages/core/src/storage.ts';
import { Uploads } from '../../../packages/core/src/uploads.ts';
import { audit, activeStates } from '../../../packages/core/src/catalog.ts';
import { transaction, lockKey } from '../../../packages/core/src/db.ts';
import { insist } from '../../../packages/core/src/errors.ts';
import { Upload } from '@tus/server';

async function exists(path: string) {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export class ValidationWorker {
  config: Config; pool: Pool; boss: PgBoss; storage: Storage; uploads: Uploads;
  afterRename?: () => Promise<void>;
  constructor(config: Config, pool: Pool, boss: PgBoss, hooks: { afterRename?: () => Promise<void> } = {}) {
    this.config = config; this.pool = pool; this.boss = boss;
    this.storage = new Storage(config); this.uploads = new Uploads(pool, config, this.storage, boss);
    this.afterRename = hooks.afterRename;
  }
  async fail(id: string, code: string) {
    const upload = await this.uploads.get(id);
    await transaction(this.pool, async (db) => {
      await db.query("UPDATE uploads SET state='error',error_code=$2,updated_at=now() WHERE id=$1 AND state<>'completed'", [id, code]);
      await db.query("UPDATE resources SET state='trashed',deleted_at=now(),folder_id=NULL WHERE id=$1 AND state='draft'", [upload.resource_id]);
      await audit(db, null, 'upload.validation', id, code);
    });
  }
  async validate(id: string) {
    await this.uploads.locker.using(id, async () => {
      await this.storage.ready();
      const row = await this.uploads.get(id);
      if (row.state === 'completed' || !activeStates.includes(row.state) || !row.expected_sha256) return;
      if (row.validation_attempts >= 5) { await this.fail(id, 'VALIDATION_RETRIES_EXHAUSTED'); return; }
      await this.pool.query("UPDATE uploads SET state=CASE WHEN state='publishing' THEN state ELSE 'verifying' END,validation_attempts=validation_attempts+1,updated_at=now() WHERE id=$1", [id]);
      try {
        const source = this.storage.path('incoming', id), destination = this.storage.path('objects', row.version_id);
        const alreadyRenamed = await exists(destination);
        const area = alreadyRenamed ? 'objects' : 'incoming';
        const key = alreadyRenamed ? row.version_id : id;
        const { info } = await this.storage.regular(area, key);
        const actual = await this.storage.hash(area, key);
        if (String(info.size) !== String(row.size_bytes) || actual !== row.expected_sha256) {
          const bad = this.storage.path('quarantine', id);
          insist(!await exists(bad), 409, 'QUARANTINE_CONFLICT', 'Un contrôle manuel est requis.');
          await rename(this.storage.path(area, key), bad);
          await chmod(bad, 0o600);
          await this.fail(id, String(info.size) !== String(row.size_bytes) ? 'SIZE_MISMATCH' : 'HASH_MISMATCH');
          return;
        }
        await this.pool.query("UPDATE uploads SET state='publishing',actual_sha256=$2,received_bytes=size_bytes,updated_at=now() WHERE id=$1", [id, actual]);
        if (!alreadyRenamed) {
          const file = await open(source, 'r+');
          try { await file.sync(); await file.chmod(0o440); await file.sync(); } finally { await file.close(); }
          await rename(source, destination);
          await syncDirectory(join(this.config.STORAGE_ROOT, 'incoming'));
          await syncDirectory(join(this.config.STORAGE_ROOT, 'objects'));
        } else await chmod(destination, 0o440);
        await this.afterRename?.();
        await transaction(this.pool, async (db) => {
          const resource = (await db.query('SELECT * FROM resources WHERE id=$1 FOR UPDATE', [row.resource_id])).rows[0];
          insist(resource && ['draft', 'ready', 'missing'].includes(resource.state) && resource.current_version_id === row.base_version_id,
            409, 'RESOURCE_CHANGED', 'La ressource a changé pendant la validation.');
          const number = (await db.query('SELECT coalesce(max(number),0)+1 AS next FROM resource_versions WHERE resource_id=$1', [row.resource_id])).rows[0].next;
          await db.query(`INSERT INTO resource_versions(id,resource_id,number,uploader_id,size_bytes,sha256)
            VALUES($1,$2,$3,$4,$5,$6)`, [row.version_id, row.resource_id, number, row.owner_id, row.size_bytes, actual]);
          await db.query('UPDATE resource_versions SET retired_at=now() WHERE id=$1', [row.base_version_id]);
          await db.query("UPDATE resources SET state='ready',current_version_id=$2,revision=revision+1,updated_at=now() WHERE id=$1", [row.resource_id, row.version_id]);
          await db.query("UPDATE uploads SET state='completed',error_code=NULL,updated_at=now() WHERE id=$1", [id]);
          await audit(db, null, 'upload.published', id);
        });
        await this.uploads.store.configstore.delete(id);
      } catch (error) {
        if ((error as { code?: string }).code === 'RESOURCE_CHANGED') { await this.fail(id, 'RESOURCE_CHANGED'); return; }
        await this.pool.query("UPDATE uploads SET error_code='VALIDATION_RETRY',updated_at=now() WHERE id=$1 AND state<>'completed'", [id]);
        throw error;
      }
    });
  }
  async reconcile() {
    await this.storage.ready();
    const pending = await this.pool.query('SELECT * FROM uploads WHERE state=ANY($1) ORDER BY created_at LIMIT 200', [activeStates]);
    for (const upload of pending.rows) {
      try {
      if (upload.state === 'reserved') { await this.uploads.initialize(upload.id); continue; }
      if (['uploading', 'received'].includes(upload.state) && !upload.expected_sha256) {
        await this.uploads.locker.using(upload.id, async () => {
          const current = await this.uploads.get(upload.id);
          if (!['uploading', 'received'].includes(current.state) || current.expected_sha256) return;
          const path = this.storage.path('incoming', current.id);
          if (!await exists(path)) { await this.fail(current.id, 'PARTIAL_MISSING'); return; }
          const { info } = await this.storage.regular('incoming', current.id);
          if (BigInt(info.size) > BigInt(current.size_bytes)) { await this.fail(current.id, 'SIZE_MISMATCH'); return; }
          // La base possède la taille attendue ; seul le fichier donne l'offset
          // effectivement conservé après une coupure ou un redémarrage.
          await this.uploads.store.configstore.set(current.id, new Upload({ id: current.id, size: Number(current.size_bytes), offset: info.size, metadata: {} }));
          await this.pool.query(`UPDATE uploads SET received_bytes=$2,
            last_activity_at=CASE WHEN received_bytes<>$2 THEN now() ELSE last_activity_at END WHERE id=$1`, [current.id, String(info.size)]);
        });
        const refreshed = await this.uploads.get(upload.id);
        if (Date.now() - new Date(refreshed.last_activity_at).getTime() > this.config.UPLOAD_IDLE_DAYS * 86400000) {
          await this.uploads.cancel(null, upload.id, true);
        }
      } else if (upload.expected_sha256) await this.boss.send('validate-upload', { id: upload.id }, { singletonKey: upload.id });
      } catch (error) {
        if ((error as { code?: string }).code === 'OBJECT_UNAVAILABLE') await this.fail(upload.id, 'INVALID_PARTIAL');
        else await audit(this.pool, null, 'upload.reconcile', upload.id, 'error');
      }
    }
    const resources = await this.pool.query(`SELECT r.id,r.state,v.id AS version_id,v.size_bytes,v.sha256 FROM resources r
      JOIN resource_versions v ON v.id=r.current_version_id WHERE r.state IN ('ready','missing')`);
    for (const row of resources.rows) {
      let correct = false;
      try {
        const object = await this.storage.regular('objects', row.version_id);
        correct = String(object.info.size) === String(row.size_bytes);
        if (correct && row.state === 'missing') correct = await this.storage.hash('objects', row.version_id) === row.sha256;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as { statusCode?: number }).statusCode !== 404) throw error; }
      const state = correct ? 'ready' : 'missing';
      if (state !== row.state) {
        await this.pool.query("UPDATE resources SET state=$2 WHERE id=$1 AND state IN ('ready','missing')", [row.id, state]);
        await audit(this.pool, null, 'resource.reconcile', row.id, state);
      }
    }
    await this.purge();
  }
  async purge() {
    await this.storage.ready();
    await transaction(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey('mprovi:backup-purge')]);
      if ((await db.query('SELECT 1 FROM backup_leases WHERE expires_at>now() LIMIT 1')).rowCount) return;
      const expired = await db.query(`SELECT v.id FROM resource_versions v JOIN resources r ON r.id=v.resource_id
        WHERE v.purged_at IS NULL AND ((r.state='trashed' AND r.deleted_at<now()-$1*interval '1 day')
        OR (v.id<>r.current_version_id AND v.retired_at<now()-$1*interval '1 day')) FOR UPDATE OF v`, [this.config.RETENTION_DAYS]);
      for (const row of expired.rows) {
        const path = this.storage.path('objects', row.id);
        if (await exists(path)) { await this.storage.regular('objects', row.id); await unlink(path); }
        await db.query('UPDATE resource_versions SET purged_at=now() WHERE id=$1', [row.id]);
        await audit(db, null, 'version.purge', row.id);
      }
      // Les objets inconnus sont déplacés en quarantaine après sept jours ;
      // jamais effacés directement lors de leur découverte.
      for (const name of await readdir(join(this.config.STORAGE_ROOT, 'objects'))) {
        if (!/^[0-9a-f-]{36}$/.test(name)) continue;
        const entry = await lstat(this.storage.path('objects', name));
        if (!entry.isFile() || entry.isSymbolicLink()) { await audit(db, null, 'object.invalid', name, 'error'); continue; }
        const { info, path } = await this.storage.regular('objects', name);
        if (Date.now() - info.mtimeMs < this.config.UPLOAD_IDLE_DAYS * 86400000) continue;
        const known = await db.query(`SELECT 1 FROM resource_versions WHERE id=$1 AND purged_at IS NULL
          UNION ALL SELECT 1 FROM uploads WHERE version_id=$1 AND state IN ('verifying','publishing') LIMIT 1`, [name]);
        if (!known.rowCount) {
          const target = this.storage.path('quarantine', name);
          if (!await exists(target)) { await rename(path, target); await chmod(target, 0o600); await audit(db, null, 'object.quarantine', name); }
        }
      }
      for (const name of await readdir(join(this.config.STORAGE_ROOT, 'quarantine'))) {
        if (!/^[0-9a-f-]{36}$/.test(name)) continue;
        const entry = await lstat(this.storage.path('quarantine', name));
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const { info, path } = await this.storage.regular('quarantine', name);
        if (Date.now() - info.ctimeMs > this.config.UPLOAD_IDLE_DAYS * 86400000) await unlink(path);
      }
      await db.query('DELETE FROM service_nonces WHERE expires_at<now()');
      await db.query('DELETE FROM login_transactions WHERE expires_at<now()');
      await db.query('DELETE FROM sessions WHERE idle_expires_at<now() OR absolute_expires_at<now()');
      await db.query("DELETE FROM audit_events WHERE occurred_at<now()-$1*interval '1 day'", [this.config.AUDIT_RETENTION_DAYS]);
      await db.query("DELETE FROM download_aggregates WHERE day<current_date-interval '12 months'");
      await db.query('DELETE FROM backup_leases WHERE expires_at<now()');
    });
  }
}
