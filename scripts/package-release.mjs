import { mkdir, cp, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const revision = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('SHA Git complet requis.');
const output = resolve('dist/release'), staging = resolve('dist/staging');
await mkdir(output, { recursive: true });
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const path of ['apps/api', 'apps/worker', 'apps/web/dist', 'packages/core', 'packages/mcp', 'moodle', 'docs', 'package.json', 'package-lock.json']) {
  await mkdir(resolve(staging, path, '..'), { recursive: true });
  await cp(path, join(staging, path), { recursive: true });
}
await writeFile(join(staging, 'release.json'), JSON.stringify({ revision, node: '24', schema: 1, createdAt: new Date().toISOString() }) + '\n');
const archive = join(output, 'application.tar.gz');
const tar = spawnSync('tar', ['-czf', archive, '-C', staging, '.'], { stdio: 'inherit' });
if (tar.status !== 0) throw new Error('Échec de création de la livraison.');
await writeFile(join(output, 'application.sha256'), `${createHash('sha256').update(await readFile(archive)).digest('hex')}  application.tar.gz\n`);
console.log(`Livraison ${revision} créée.`);
