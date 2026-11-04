import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('Tiny Moodle : le module compilé retourne directement son plugin et sa configuration', async () => {
  const source = await readFile('moodle/lib/editor/tiny/plugins/filesharing/amd/build/plugin.min.js', 'utf8');
  const registered = new Map();
  let loaded;
  const modules = {
    'editor_tiny/loader': { getTinyMCE: async () => ({ PluginManager: { add: (name, setup) => registered.set(name, setup) } }) },
    'editor_tiny/utils': { getPluginMetadata: async () => ({ getMetadata: () => ({ name: 'Filesharing' }) }),
      addToolbarButton: (toolbar, section, button) => toolbar.map((item) => item.name === section ? { ...item, items: [...item.items, button] } : item),
      addMenubarItem: (menu, section, button) => ({ ...menu, [section]: { ...menu[section], items: `${menu[section].items} ${button}` } }) },
    'editor_tiny/options': { getContextId: () => 1 },
    'core/str': { getString: async () => 'Select an educational resource' },
    'core/notification': { exception: (error) => { throw error; } },
    'local_filesharing/selector': { open: async () => {} },
  };
  runInNewContext(source, { define(name, dependencies, factory) {
    assert.equal(name, 'tiny_filesharing/plugin');
    const exports = {};
    loaded = factory(...dependencies.map((name) => name === 'exports' ? exports : modules[name])) ?? exports;
  } });
  // This is the contract used by Moodle's importPluginList: await the AMD value,
  // then accept a string or [pluginName, configuration], never {default: Promise}.
  assert.equal(typeof loaded?.then, 'function', 'Le chargeur Moodle doit recevoir la Promise, sans enveloppe default.');
  const plugin = await loaded;
  assert.ok(Array.isArray(plugin));
  assert.equal(plugin[0], 'tiny_filesharing/plugin');
  assert.equal(typeof plugin[1].configure, 'function');
  const configured = plugin[1].configure({ toolbar: [{ name: 'content', items: ['image'] }], menu: { insert: { title: 'Insert', items: 'image' } } });
  assert.ok(configured.toolbar[0].items.includes('tiny_filesharing/resources'));
  assert.ok(configured.menu.insert.items.includes('tiny_filesharing/resources'));
  const buttons = new Map(), menuItems = new Map();
  registered.get(plugin[0])({ ui: { registry: {
    addIcon() {}, addButton: (name, definition) => buttons.set(name, definition), addMenuItem: (name, definition) => menuItems.set(name, definition),
  } } });
  assert.equal(buttons.get('tiny_filesharing/resources').tooltip, 'Select an educational resource');
  assert.ok(menuItems.has('tiny_filesharing/resources'));
});
