import { lstat, realpath, readFile, statfs, stat, open } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Config } from './config.ts';
import { insist } from './errors.ts';

export class Storage {
  config: Config;
  constructor(config: Config) { this.config = config; }
  path(area: 'incoming' | 'objects' | 'quarantine', id: string) {
    insist(/^[0-9a-f-]{36}$/.test(id) && !id.includes('/'), 400, 'INVALID_ID', 'Identifiant invalide.');
    return join(this.config.STORAGE_ROOT, area, id);
  }
  async ready() {
    try {
      const root = this.config.STORAGE_ROOT;
      insist(await realpath(root) === resolve(root), 503, 'STORAGE_UNAVAILABLE', 'Le volume de ressources est indisponible.');
      const rootStat = await lstat(root);
      if (this.config.NODE_ENV === 'production') {
        insist(rootStat.dev !== (await stat(dirname(root))).dev, 503, 'STORAGE_UNAVAILABLE', 'Le volume dédié n’est pas monté.');
      }
      const marker = await open(join(root, '.mprovi-volume'), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try { insist((await marker.readFile('utf8')).trim() === this.config.STORAGE_MARKER, 503, 'STORAGE_UNAVAILABLE', 'Le volume attendu est absent.'); }
      finally { await marker.close(); }
      for (const area of ['incoming', 'objects', 'quarantine']) {
        const info = await lstat(join(root, area));
        insist(info.isDirectory() && !info.isSymbolicLink() && info.dev === rootStat.dev,
          503, 'STORAGE_UNAVAILABLE', 'Le stockage n’est pas correctement monté.');
      }
    } catch { throw Object.assign(new Error('Le volume de ressources est indisponible.'), { statusCode: 503, code: 'STORAGE_UNAVAILABLE' }); }
  }
  async space() {
    await this.ready();
    const stats = await statfs(this.config.STORAGE_ROOT, { bigint: true });
    const total = stats.blocks * stats.bsize, free = stats.bavail * stats.bsize;
    const margin = total / 20n > this.config.MIN_FREE_BYTES ? total / 20n : this.config.MIN_FREE_BYTES;
    return { total, free, margin };
  }
  async regular(area: 'incoming' | 'objects' | 'quarantine', id: string) {
    const path = this.path(area, id);
    const info = await lstat(path);
    insist(info.isFile() && !info.isSymbolicLink(), 404, 'OBJECT_UNAVAILABLE', 'Fichier indisponible.');
    return { path, info };
  }
  async hash(area: 'incoming' | 'objects', id: string) {
    const { path } = await this.regular(area, id);
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const hash = createHash('sha256');
    try {
      for await (const part of file.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) hash.update(part);
      return hash.digest('hex');
    } finally { await file.close(); }
  }
}
