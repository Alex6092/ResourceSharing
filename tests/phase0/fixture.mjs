import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, writeFile, readFile, chmod, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const resourceId = 'da4aa500-3d8c-48be-b8bb-08491982ea22';
export const versionIds = [
  'e63484c3-2214-48f3-a076-64dd51c61041',
  '7b0383fb-cf4d-4b57-b110-f34e3cd5f338',
];

export function pattern(size, offset = 0, seed = 0) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (offset + i + seed) % 251;
  return bytes;
}

export async function createFixture(root, size = 2 * 1024 * 1024) {
  root = resolve(root);
  await mkdir(root, { recursive: true });
  for (const name of ['incoming', 'objects', 'quarantine', 'private']) {
    await mkdir(join(root, name), { mode: name === 'objects' ? 0o755 : 0o700 });
    // Le banc root impose umask 077 : rendre explicite le répertoire qu'Apache
    // et l'API doivent pouvoir traverser, sans élargir incoming/private.
    if (name === 'objects') await chmod(join(root, name), 0o755);
  }
  const marker = randomUUID();
  await writeFile(join(root, '.phase0-volume'), marker, { mode: 0o644 });
  await chmod(join(root, '.phase0-volume'), 0o644);
  const identities = ['teacherA', 'teacherB', 'student'].map((id) => ({
    id, token: randomBytes(32).toString('base64url'), canUpload: id !== 'student',
  }));
  await writeFile(join(root, 'private', 'identities.json'), JSON.stringify(identities), { mode: 0o600 });
  const versions = [];
  for (const [index, id] of versionIds.entries()) {
    const path = join(root, 'objects', id);
    const file = await open(path, 'wx', 0o644);
    const hash = createHash('sha256');
    try {
      for (let offset = 0; offset < size;) {
        const block = pattern(Math.min(65536, size - offset), offset, index * 17);
        await file.writeFile(block);
        hash.update(block);
        offset += block.length;
      }
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(path, 0o444);
    versions.push({ id, sha256: hash.digest('hex'), size, seed: index * 17 });
  }
  const fixture = { marker, resourceId, currentVersionId: versions[0].id, versions };
  await writeFile(join(root, 'fixture.json'), JSON.stringify(fixture), { mode: 0o644 });
  await chmod(join(root, 'fixture.json'), 0o644);
  return { root, ...fixture, identities };
}

export async function loadFixture(root) {
  const [fixture, identities] = await Promise.all([
    readFile(join(root, 'fixture.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'private', 'identities.json'), 'utf8').then(JSON.parse),
  ]);
  return { root: resolve(root), ...fixture, identities };
}

export async function replaceFixtureVersion(root, id) {
  const path = join(root, 'fixture.json');
  const fixture = JSON.parse(await readFile(path, 'utf8'));
  if (!fixture.versions.some((version) => version.id === id)) throw new Error('Version inconnue.');
  fixture.currentVersionId = id;
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(fixture), { mode: 0o644 });
  await chmod(temporary, 0o644);
  await rename(temporary, path);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (!process.argv[2]) throw new Error('Usage : node fixture.mjs REPERTOIRE_VIDE');
  await createFixture(process.argv[2], Number(process.env.PHASE0_FIXTURE_BYTES || 33554432));
  console.log('Jeu de données de faisabilité créé ; aucun secret affiché.');
}
