import assert from 'node:assert/strict';
import { access, open, unlink, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (process.platform !== 'linux' || process.getuid() === 0 || !root) throw new Error('Test Linux non privilégié requis.');
const fixture = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8'));
const object = join(root, 'objects', fixture.versions[0].id);
await access(object, constants.R_OK);
await assert.rejects(open(object, 'r+'), { code: 'EACCES' });
await assert.rejects(open(join(root, 'objects', 'forbidden'), 'wx'), { code: 'EACCES' });
const temporary = join(root, 'incoming', 'permissions-probe');
const file = await open(temporary, 'wx', 0o600);
await file.close();
await unlink(temporary);
console.log('Permissions de lecture et séparation des écritures vérifiées.');
