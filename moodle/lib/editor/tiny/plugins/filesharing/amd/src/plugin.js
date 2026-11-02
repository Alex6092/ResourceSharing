// SPDX-License-Identifier: GPL-3.0-or-later
import {getTinyMCE} from 'editor_tiny/loader';
import {getPluginMetadata, addToolbarButton, addMenubarItem} from 'editor_tiny/utils';
import {getContextId} from 'editor_tiny/options';
import {getString} from 'core/str';
import {exception} from 'core/notification';
import {open} from 'local_filesharing/selector';

const component = 'tiny_filesharing';
const button = `${component}/resources`;
export default (async() => {
    const [tiny, metadata, label] = await Promise.all([
        getTinyMCE(), getPluginMetadata(component, component), getString('selectresource', 'local_filesharing'),
    ]);
    tiny.PluginManager.add(`${component}/plugin`, editor => {
        editor.ui.registry.addIcon('filesharing-folder', '<svg viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v11H3z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>');
        const action = () => {
            const bookmark = editor.selection.getBookmark(2, true);
            void open(getContextId(editor), link => {
                editor.focus(); editor.selection.moveToBookmark(bookmark);
                const anchor = editor.getDoc().createElement('a');
                anchor.href = link.url; anchor.textContent = link.label;
                editor.insertContent(anchor.outerHTML);
            }, editor.getElement()).catch(exception);
        };
        editor.ui.registry.addButton(button, {icon: 'filesharing-folder', tooltip: label, onAction: action});
        editor.ui.registry.addMenuItem(button, {icon: 'filesharing-folder', text: label, onAction: action});
        return metadata;
    });
    return [`${component}/plugin`, {
        configure: config => {
            let toolbar = config.toolbar;
            if (!Array.isArray(toolbar)) toolbar = [];
            if (!toolbar.some(section => section.name === 'content')) toolbar = [...toolbar, {name: 'content', items: []}];
            return {...config, toolbar: addToolbarButton(toolbar, 'content', button),
                menu: config.menu ? addMenubarItem(config.menu, 'insert', button) : {insert: {title: 'Insert', items: button}}};
        },
    }];
})();
