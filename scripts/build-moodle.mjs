import { transformAsync } from '@babel/core';
import amd from '@babel/plugin-transform-modules-amd';
import { minify } from 'terser';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const modules = [
  ['local_filesharing', 'moodle/local/filesharing'],
  ['tiny_filesharing', 'moodle/lib/editor/tiny/plugins/filesharing'],
];
for (const [component, root] of modules) {
  const directory = join(root, 'amd', 'src');
  await mkdir(join(root, 'amd', 'build'), { recursive: true });
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.js')) continue;
    const source = await readFile(join(directory, name), 'utf8');
    const transformed = await transformAsync(source, { filename: name, configFile: false, babelrc: false,
      plugins: [[amd, { moduleIds: true, moduleId: `${component}/${name.slice(0, -3)}` }]],
    });
    const result = await minify(transformed.code, { format: { comments: /SPDX-License-Identifier/ }, ecma: 2022 });
    await writeFile(join(root, 'amd', 'build', name.replace(/\.js$/, '.min.js')), result.code + '\n');
  }
}
console.log('Modules AMD Moodle compilés.');
