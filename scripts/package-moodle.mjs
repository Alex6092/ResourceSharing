import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

// Small deterministic ZIP writer: UTF-8 names, standard deflate, no symlinks.
async function files(directory, relative = '') {
  const result = [];
  for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(directory, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error('Lien symbolique interdit dans un plugin.');
  }
  return result;
}
await mkdir('dist/moodle', { recursive: true });
for (const [component, directory] of [['local_filesharing','moodle/local/filesharing'], ['tiny_filesharing','moodle/lib/editor/tiny/plugins/filesharing'], ['repository_filesharing','moodle/repository/filesharing']]) {
  const chunks = [], central = []; let offset = 0;
  for (const path of await files(directory)) {
    const name = Buffer.from(`filesharing/${path}`), bytes = await readFile(join(directory, path)), compressed = deflateRawSync(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    chunks.push(header, name, compressed);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4);
    header.copy(index, 6, 4, 30); index.writeUInt32LE(offset, 42); central.push(index, name);
    offset += header.length + name.length + compressed.length;
  }
  const directoryBytes = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  await writeFile(`dist/moodle/${component}.zip`, Buffer.concat([...chunks, directoryBytes, end]));
}
console.log('Trois archives Moodle installables créées dans dist/moodle.');
