import { mkdir, writeFile, lstat, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.ts';
import { createPool, migrate, transaction, lockKey } from './db.ts';
import { initializeQueue } from './queue.ts';
import { Storage } from './storage.ts';
import { importAccessLog } from './statistics.ts';

const command = process.argv[2];
if (!['migrate', 'storage-init', 'backup-begin', 'backup-end', 'verify', 'import-access-log'].includes(command)) {
  throw new Error('Usage : cli.ts migrate | storage-init | backup-begin | backup-end UUID | verify | import-access-log');
}
const config = loadConfig();
if (command === 'storage-init') {
  // Opération explicite uniquement. Les processus API et worker ne créent
  // jamais automatiquement un stockage absent au démarrage.
  const root = await lstat(config.STORAGE_ROOT);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Répertoire de stockage réel requis.');
  const marker = join(config.STORAGE_ROOT, '.mprovi-volume');
  try {
    const old = (await readFile(marker, 'utf8')).trim();
    if (old !== config.STORAGE_MARKER) throw new Error('Un autre stockage est déjà initialisé.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(marker, `${config.STORAGE_MARKER}\n`, { flag: 'wx', mode: 0o644 });
    await chmod(marker, 0o644);
  }
  for (const area of ['incoming', 'objects', 'quarantine']) {
    await mkdir(join(config.STORAGE_ROOT, area), { recursive: true, mode: area === 'objects' ? 0o750 : 0o700 });
    await chmod(join(config.STORAGE_ROOT, area), area === 'objects' ? 0o750 : 0o700);
  }
  await new Storage(config).ready();
  console.log('Stockage initialisé et vérifié.');
} else {
  const pool = createPool(config);
  try {
    if (command === 'migrate') {
      await migrate(pool); await initializeQueue(config);
      console.log('Migrations et file de validation initialisées.');
    } else if (command === 'backup-begin') {
      const id = randomUUID();
      await transaction(pool, async (db) => {
        await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey('mprovi:backup-purge')]);
        await db.query("INSERT INTO backup_leases(id,expires_at) VALUES($1,now()+interval '24 hours')", [id]);
      });
      console.log(id);
    } else if (command === 'backup-end') {
      if (!/^[0-9a-f-]{36}$/.test(process.argv[3] || '')) throw new Error('Identifiant de sauvegarde requis.');
      await pool.query('DELETE FROM backup_leases WHERE id=$1', [process.argv[3]]);
    } else if (command === 'import-access-log') {
      await importAccessLog(pool, '/var/log/apache2/mprovi-access.log.1');
      await importAccessLog(pool, '/var/log/apache2/mprovi-access.log');
    } else {
      const storage = new Storage(config); await storage.ready();
      const versions = await pool.query('SELECT id,size_bytes,sha256 FROM resource_versions WHERE purged_at IS NULL');
      let failures = 0;
      for (const row of versions.rows) {
        try {
          const object = await storage.regular('objects', row.id);
          if (String(object.info.size) !== row.size_bytes || await storage.hash('objects', row.id) !== row.sha256) failures++;
        } catch { failures++; }
      }
      console.log(JSON.stringify({ checked: versions.rowCount, failures }));
      if (failures) process.exitCode = 1;
    }
  } finally { await pool.end(); }
}
