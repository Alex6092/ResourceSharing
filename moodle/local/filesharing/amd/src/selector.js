// SPDX-License-Identifier: GPL-3.0-or-later
import {call} from 'core/ajax';
import Modal from 'core/modal';
import {getStrings} from 'core/str';
import {exception} from 'core/notification';

export const open = async(contextid, onSelect, returnElement) => {
    const keys = ['selectresource', 'search', 'select', 'previous', 'next', 'root', 'noresults'];
    const strings = await getStrings(keys.map(key => ({key, component: 'local_filesharing'})));
    const text = Object.fromEntries(keys.map((key, i) => [key, strings[i]]));
    const escape = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
    const modal = await Modal.create({title: escape(text.selectresource), large: true, removeOnClose: true, returnElement,
        body: `<label class="w-100">${escape(text.search)}<input class="form-control mt-2" type="search" data-region="search"></label>
            <nav class="my-2" aria-label="${escape(text.root)}" data-region="path"></nav>
            <div data-region="results" aria-live="polite"></div><div class="d-flex justify-content-between mt-3">
            <button type="button" class="btn btn-secondary" data-action="previous">${escape(text.previous)}</button>
            <button type="button" class="btn btn-secondary" data-action="next">${escape(text.next)}</button></div>`});
    const body = modal.getBody()[0];
    const search = body.querySelector('[data-region="search"]');
    const results = body.querySelector('[data-region="results"]');
    const path = body.querySelector('[data-region="path"]');
    let page = 1, folder = 'root', generation = 0, timeout;
    const stack = [{id: 'root', name: text.root}];
    const rpc = async(action, query = {}, resourceid = '') => JSON.parse(await call([{
        methodname: 'local_filesharing_catalogue', args: {contextid, action, query: JSON.stringify(query), resourceid},
    }])[0]);
    const button = (label, handler, className = 'btn btn-link') => {
        const element = document.createElement('button');
        element.type = 'button'; element.className = className; element.textContent = label;
        element.addEventListener('click', handler);
        return element;
    };
    const load = async() => {
        const request = ++generation;
        const query = {q: search.value, page, limit: 50};
        if (!search.value) query.folderId = folder;
        try {
            const [files, folders] = await Promise.all([rpc('list', query), search.value ? {items: []} : rpc('folders', {parentId: folder})]);
            if (request !== generation || !body.isConnected) return;
            path.replaceChildren();
            stack.forEach((entry, index) => path.append(button(entry.name, () => {
                folder = entry.id; stack.splice(index + 1); page = 1; void load();
            })));
            results.replaceChildren();
            for (const entry of folders.items) {
                const row = document.createElement('div');
                row.append(button(`▱ ${entry.name}`, () => {folder = entry.id; stack.push(entry); page = 1; void load();}));
                results.append(row);
            }
            for (const entry of files.items) {
                const row = document.createElement('div'); row.className = 'd-flex justify-content-between align-items-center border-bottom py-2';
                const name = document.createElement('span'); name.textContent = entry.name;
                row.append(name, button(text.select, async() => {
                    try {
                        const link = await rpc('usage', {}, entry.id);
                        const url = new URL(link.url);
                        if (!['https:', 'http:'].includes(url.protocol) || !/^\/download\/[0-9a-f-]{36}$/.test(url.pathname)) throw new Error('Invalid resource URL');
                        onSelect(link); modal.destroy();
                    } catch (error) {exception(error);}
                }, 'btn btn-outline-primary btn-sm ms-3'));
                results.append(row);
            }
            if (!files.items.length && !folders.items.length) results.textContent = text.noresults;
            body.querySelector('[data-action="previous"]').disabled = page === 1;
            body.querySelector('[data-action="next"]').disabled = !files.hasMore;
        } catch (error) {exception(error);}
    };
    search.addEventListener('input', () => {clearTimeout(timeout); timeout = setTimeout(() => {page = 1; void load();}, 300);});
    body.querySelector('[data-action="previous"]').addEventListener('click', () => {page--; void load();});
    body.querySelector('[data-action="next"]').addEventListener('click', () => {page++; void load();});
    modal.show();
    await load();
};
