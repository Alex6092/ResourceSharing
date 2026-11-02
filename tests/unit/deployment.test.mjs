import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('livraison : archive validée, substitution de révision et traversal refusés', { skip: process.platform !== 'linux' ? 'Lanceur Debian ; exécuté sur Linux et en CI.' : false }, async (t) => {
  const python = process.env.PYTHON_BINARY || (process.platform === 'win32' ? 'python' : 'python3');
  if (spawnSync(python, ['--version']).status !== 0) { t.skip('Python nécessaire au contrôle du lanceur Debian.'); return; }
  const scratch = await mkdtemp(join(tmpdir(), 'mprovi-archive-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const code = `import hashlib,io,json,pathlib,tarfile,sys
root=pathlib.Path(sys.argv[1]); revision='a'*40
for mode in ['valid','traversal','symlink','revision']:
 folder=root/mode; folder.mkdir()
 with tarfile.open(folder/'application.tar.gz','w:gz') as archive:
  data=json.dumps({'revision':('b'*40 if mode=='revision' else revision),'schema':1}).encode()
  info=tarfile.TarInfo('./release.json'); info.size=len(data); archive.addfile(info,io.BytesIO(data))
  if mode in ['traversal','symlink']:
   info=tarfile.TarInfo('../escape' if mode=='traversal' else 'apps/link')
   if mode=='symlink': info.type=tarfile.SYMTYPE; info.linkname='/etc/passwd'
   archive.addfile(info)
 (folder/'application.sha256').write_text(hashlib.sha256((folder/'application.tar.gz').read_bytes()).hexdigest())
`;
  const generator = spawnSync(python, ['-c', code, scratch], { encoding: 'utf8' });
  assert.equal(generator.status, 0, generator.stderr);
  for (const mode of ['valid', 'traversal', 'symlink', 'revision']) {
    const destination = join(scratch, `out-${mode}`); await mkdir(destination);
    const result = spawnSync(python, ['deploy/scripts/extract-release.py', resolve(scratch, mode), destination, 'a'.repeat(40)], { encoding: 'utf8' });
    if (mode === 'valid') { assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(await readFile(join(destination, 'release.json'))).revision, 'a'.repeat(40)); }
    else assert.notEqual(result.status, 0);
  }
});
