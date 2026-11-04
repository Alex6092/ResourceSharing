import { transformAsync } from '@babel/core';
import amd from '@babel/plugin-transform-modules-amd';
import { minify } from 'terser';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Moodle's AMD loader consumes default exports directly, including Promises.
// Match its .grunt/babel-plugin-add-module-to-define.js contract instead of
// returning Babel's {default: value} namespace, which Tiny silently ignores.
const moodleDefaultExport = ({ types }) => ({
  name: 'moodle-default-export',
  post(file) {
    const definition = file.ast.program.body.find((statement) => types.isExpressionStatement(statement)
      && types.isCallExpression(statement.expression) && types.isIdentifier(statement.expression.callee, { name: 'define' }))?.expression;
    if (!definition) throw new Error('Module AMD Moodle attendu.');
    const dependencies = definition.arguments[1], factory = definition.arguments[2];
    const index = dependencies.elements.findIndex((entry) => types.isStringLiteral(entry, { value: 'exports' }));
    if (index < 0) return;
    const exports = factory.params[index].name;
    let hasDefault = false;
    types.traverseFast(factory.body, (node) => {
      if (types.isAssignmentExpression(node) && types.isMemberExpression(node.left)
          && types.isIdentifier(node.left.object, { name: exports })
          && ((!node.left.computed && types.isIdentifier(node.left.property, { name: 'default' }))
            || (node.left.computed && types.isStringLiteral(node.left.property, { value: 'default' })))) hasDefault = true;
    });
    if (hasDefault) factory.body.body.push(types.returnStatement(types.memberExpression(types.identifier(exports), types.identifier('default'))));
  },
});

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
      plugins: [[amd, { moduleIds: true, moduleId: `${component}/${name.slice(0, -3)}` }], moodleDefaultExport],
    });
    const result = await minify(transformed.code, { format: { comments: /SPDX-License-Identifier/ }, ecma: 2022 });
    await writeFile(join(root, 'amd', 'build', name.replace(/\.js$/, '.min.js')), result.code + '\n');
  }
}
console.log('Modules AMD Moodle compilés.');
