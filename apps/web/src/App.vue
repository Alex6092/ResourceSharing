<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import Uppy from '@uppy/core';
import Dashboard from '@uppy/dashboard';
import Tus from '@uppy/tus';
import French from '@uppy/locales/lib/fr_FR.js';
import '@uppy/core/css/style.min.css';
import '@uppy/dashboard/css/style.min.css';
import { fr as text } from './i18n.ts';
import type { Resource, Folder, Transfer, Profile } from './types.ts';

class ApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const profile = ref<Profile | null>(null), moodleUrl = ref(''), loading = ref(true), notice = ref(''), error = ref('');
const rows = ref<Resource[]>([]), folders = ref<Folder[]>([]), transfers = ref<Transfer[]>([]), space = ref<Record<string, string>>({});
const current = ref<string | null>(null), search = ref(''), sort = ref('name'), order = ref('asc'), trash = ref(false), page = ref(1), hasMore = ref(false);
const showUploads = ref(false), dashboard = ref<HTMLDivElement>(), chooser = ref<HTMLInputElement>(), modal = ref<HTMLDialogElement>();
const selected = ref<Resource | null>(null), operation = ref(''), editName = ref(''), destination = ref<string>('root');
const selectedFolder = ref<Folder | null>(null);
const versions = ref<Array<{ id: string; number: number; sizeBytes: string; sha256: string; purgedAt: string | null }>>([]);
const usages = ref(0), tokens = ref<Array<{ id: string; name: string; revokedAt: string | null; expiresAt: string }>>([]), freshToken = ref('');
const stateLabels: Record<string, string> = { reserved: text.reservedState, uploading: text.uploading, received: text.received, verifying: text.verifying,
  publishing: text.publishing, completed: text.completed, cancelled: text.cancelled, expired: text.expired, error: text.error };
const can = (cap: string) => !!profile.value && (profile.value.capabilities.includes(cap) || profile.value.capabilities.includes('admin'));
const canEdit = (resource: Resource) => can('upload') && (resource.ownerId === profile.value?.id || can('manageothers'));
const visibleFolders = computed(() => folders.value.filter((folder) => folder.parentId === current.value));
const breadcrumbs = computed(() => {
  const result: Folder[] = [], seen = new Set<string>(); let id = current.value;
  while (id && !seen.has(id)) { seen.add(id); const folder = folders.value.find((f) => f.id === id); if (!folder) break; result.unshift(folder); id = folder.parentId; }
  return result;
});
const formatSize = (value: string | number | undefined) => {
  let size = Number(value || 0), unit = 0; const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  while (size >= 1000 && unit < units.length - 1) { size /= 1000; unit++; }
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: unit ? 1 : 0 }).format(size)} ${units[unit]}`;
};
const date = (value: string) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(value));
const usedPercent = computed(() => Math.min(100, Number(space.value.usedBytes || 0) / Math.max(1, Number(space.value.totalBytes || 0)) * 100));
let uppy: Uppy | undefined, timer: ReturnType<typeof setInterval>, debounce: ReturnType<typeof setTimeout>, generation = 0;
let pendingReplacement: Resource | null = null;
const queued: string[] = [], running = new Set<string>(), finished = new Set<string>(), cancelled = new Set<string>();
const hashProgress = ref<Record<string, number>>({});
const hashWorkers = new Map<string, Worker>();
const cancelHash = new Map<string, () => void>();
const hashWaiting: Array<() => void> = [];
let activeHashes = 0;

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(profile.value ? { 'X-CSRF-Token': profile.value.csrfToken } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.message || text.failed);
  return data;
}
function report(reason: unknown) { error.value = reason instanceof Error ? reason.message : text.failed; }
function flash(message: string) { notice.value = message; setTimeout(() => { notice.value = ''; }, 5000); }
async function reload() {
  if (!profile.value) return;
  const ownGeneration = ++generation;
  const q = new URLSearchParams({ q: search.value, sort: sort.value, order: order.value, trash: String(trash.value), page: String(page.value) });
  if (!search.value) q.set('folderId', current.value || 'root');
  try {
    const [resources, tree, disk, pending] = await Promise.all([
      api<{ items: Resource[]; hasMore: boolean }>('GET', `/api/v1/resources?${q}`),
      api<{ items: Folder[] }>('GET', '/api/v1/folders'), api<Record<string, string>>('GET', '/api/v1/storage'),
      api<{ items: Transfer[] }>('GET', '/api/v1/uploads'),
    ]);
    if (ownGeneration !== generation) return;
    rows.value = resources.items; hasMore.value = resources.hasMore; folders.value = tree.items; space.value = disk; transfers.value = pending.items;
  } catch (reason) { report(reason); }
}
async function refreshTransfers() {
  if (!profile.value) return;
  try {
    const next = await api<{ items: Transfer[] }>('GET', '/api/v1/uploads');
    const changed = next.items.some((item) => item.state === 'completed' && transfers.value.find((old) => old.id === item.id)?.state !== 'completed');
    transfers.value = next.items;
    if (changed) await reload();
  } catch { /* la prochaine action affiche les erreurs de session */ }
}
function selectFolder(id: string | null) { current.value = id; search.value = ''; page.value = 1; }
watch([current, sort, order, trash, page], () => { void reload(); });
watch(search, () => { clearTimeout(debounce); debounce = setTimeout(() => { page.value = 1; void reload(); }, 300); });

async function fingerprint(file: File) {
  const first = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const last = new Uint8Array(await file.slice(Math.max(0, file.size - 65536)).arrayBuffer());
  const meta = new TextEncoder().encode(`${file.size}:${file.lastModified}`);
  const bytes = new Uint8Array(first.length + last.length + meta.length);
  bytes.set(first); bytes.set(last, first.length); bytes.set(meta, first.length + last.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hash(fileId: string, file: File) {
  const promise = new Promise<string>((resolve, reject) => {
    const run = () => {
      if (cancelled.has(fileId)) { reject(new Error(text.cancelled)); hashWaiting.shift()?.(); return; }
      activeHashes++;
      const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' }); hashWorkers.set(fileId, worker);
      let ended = false;
      const done = () => { if (ended) return; ended = true; worker.terminate(); hashWorkers.delete(fileId); cancelHash.delete(fileId); activeHashes--; hashWaiting.shift()?.(); };
      cancelHash.set(fileId, () => { done(); reject(new Error(text.cancelled)); });
      worker.onmessage = (event) => {
        if (event.data.progress !== undefined) hashProgress.value[fileId] = event.data.progress;
        if (event.data.sha256) { hashProgress.value[fileId] = 1; done(); resolve(event.data.sha256); }
        else if (event.data.error) { done(); reject(new Error(event.data.error)); }
      };
      worker.onerror = () => { done(); reject(new Error('Le calcul SHA-256 a été interrompu.')); };
      worker.postMessage(file);
    };
    if (activeHashes < 2) run(); else hashWaiting.push(run);
  });
  void promise.catch(() => {});
  return promise;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function runOne(fileId: string) {
  const file = uppy!.getFile(fileId);
  if (!file || !(file.data instanceof File)) return;
  const data = file.data;
  const sample = await fingerprint(data);
  const old = await api<{ items: Transfer[] }>('GET', '/api/v1/uploads');
  let upload = old.items.find((item) => ['reserved', 'uploading', 'received'].includes(item.state)
    && item.fingerprint === sample && item.sizeBytes === String(data.size)
    && (!file.meta.replaceResourceId || item.resourceId === file.meta.replaceResourceId));
  if (!upload) upload = await api<Transfer>('POST', '/api/v1/uploads', { name: file.name, sizeBytes: String(data.size),
    fingerprint: sample, folderId: file.meta.folderId || null,
    ...(file.meta.replaceResourceId ? { replaceResourceId: file.meta.replaceResourceId, revision: file.meta.revision } : {}),
  });
  if (cancelled.has(fileId) || !uppy!.getFile(fileId)) { await api('DELETE', `/api/v1/uploads/${upload.id}`); return; }
  uppy!.setFileMeta(fileId, { uploadId: upload.id });
  uppy!.setFileState(fileId, { tus: { uploadUrl: upload.uploadUrl } });
  const digest = hash(fileId, data);
  const result = await uppy!.retryUpload(fileId);
  if (result?.failed?.length || cancelled.has(fileId)) throw new Error(text.failed);
  await api('POST', `/api/v1/uploads/${upload.id}/finalize`, { sha256: await digest });
  await refreshTransfers();
  while (!cancelled.has(fileId)) {
    const state = await api<Transfer>('GET', `/api/v1/uploads/${upload.id}`);
    if (state.state === 'completed') { finished.add(fileId); await reload(); return; }
    if (['error', 'cancelled', 'expired'].includes(state.state)) throw new Error(state.errorCode === 'HASH_MISMATCH'
      ? 'Les empreintes diffèrent : le fichier n’a pas été publié. Relancez le dépôt.' : 'La validation a échoué. Le fichier n’a pas été publié.');
    await sleep(2000);
  }
}
function pump() {
  while (running.size < 3 && queued.length) {
    const id = queued.shift()!;
    if (!uppy?.getFile(id) || finished.has(id) || cancelled.has(id)) continue;
    running.add(id);
    void runOne(id).catch(async (reason) => {
      if (reason instanceof ApiError && reason.status === 429 && !cancelled.has(id)) { await sleep(5000); queued.push(id); }
      else if (!cancelled.has(id)) report(reason);
    }).finally(() => { running.delete(id); pump(); });
  }
}
function startTransfers() {
  for (const file of uppy?.getFiles() || []) if (!queued.includes(file.id) && !running.has(file.id) && !finished.has(file.id)) { cancelled.delete(file.id); queued.push(file.id); }
  pump();
}
function setupUploader() {
  if (!dashboard.value || uppy) return;
  uppy = new Uppy({ autoProceed: false, locale: French });
  uppy.use(Dashboard, { target: dashboard.value, inline: true, width: '100%', height: 290,
    proudlyDisplayPoweredByUppy: false, hideProgressDetails: false, hideUploadButton: true, hideRetryButton: true,
    note: text.resumeHint, locale: French, disableThumbnailGenerator: true });
  uppy.use(Tus, { endpoint: '/tus/uploads', limit: 3, chunkSize: 16 * 1024 * 1024,
    retryDelays: [0, 1000, 3000, 5000, 10000, 30000], withCredentials: true,
    headers: () => ({ 'X-CSRF-Token': profile.value?.csrfToken || '' }),
  });
  uppy.on('file-added', (file) => {
    uppy!.setFileMeta(file.id, { folderId: current.value,
      ...(pendingReplacement ? { replaceResourceId: pendingReplacement.id, revision: pendingReplacement.revision } : {}),
    });
    pendingReplacement = null;
  });
  uppy.on('file-removed', (file) => {
    if (finished.has(file.id)) return;
    cancelled.add(file.id);
    cancelHash.get(file.id)?.();
    if (file.meta.uploadId) void api('DELETE', `/api/v1/uploads/${file.meta.uploadId}`).then(refreshTransfers).catch(report);
  });
}
async function openOperation(kind: string, resource: Resource | null = null) {
  operation.value = kind; selected.value = resource; editName.value = resource?.name || ''; destination.value = resource?.folderId || current.value || 'root';
  versions.value = []; freshToken.value = ''; usages.value = 0;
  try {
    if (resource && kind === 'versions') versions.value = (await api('GET', `/api/v1/resources/${resource.id}/versions`)).items;
    if (resource && kind === 'remove') usages.value = (await api('GET', `/api/v1/resources/${resource.id}/usages`)).items.length;
    if (kind === 'tokens') tokens.value = (await api('GET', '/api/v1/service-accounts')).items;
    modal.value?.showModal();
  } catch (reason) { report(reason); }
}
async function submitOperation() {
  const resource = selected.value;
  try {
    if (operation.value === 'newFolder') await api('POST', '/api/v1/folders', { name: editName.value, parentId: current.value });
    else if (operation.value === 'folderMove' && selectedFolder.value) await api('PATCH', `/api/v1/folders/${selectedFolder.value.id}`, { name: selectedFolder.value.name, parentId: destination.value === 'root' ? null : destination.value, revision: selectedFolder.value.revision });
    else if (operation.value === 'rename' && resource) await api('PATCH', `/api/v1/resources/${resource.id}`, { name: editName.value, revision: resource.revision });
    else if (operation.value === 'move' && resource) await api('PATCH', `/api/v1/resources/${resource.id}`, { folderId: destination.value === 'root' ? null : destination.value, revision: resource.revision });
    else if (operation.value === 'remove' && resource) await api('DELETE', `/api/v1/resources/${resource.id}`, { revision: resource.revision });
    else if (operation.value === 'restore' && resource) await api('POST', `/api/v1/resources/${resource.id}/restore`, { revision: resource.revision });
    else if (operation.value === 'tokens') {
      const created = await api('POST', '/api/v1/service-accounts', { name: editName.value || 'Agent IA', scopes: ['resources:read', 'folders:read', 'availability:read'] });
      freshToken.value = created.token; tokens.value = (await api('GET', '/api/v1/service-accounts')).items; return;
    }
    modal.value?.close(); await reload();
  } catch (reason) { report(reason); }
}
async function copyLink(resource: Resource, html = false) {
  try { const link = await api('GET', `/api/v1/resources/${resource.id}/link`); await navigator.clipboard.writeText(html ? link.html : link.url); flash(text.copied); }
  catch (reason) { report(reason); }
}
function replace(resource: Resource) { pendingReplacement = resource; chooser.value!.click(); }
function chooseReplacement(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  if (file) { showUploads.value = true; uppy?.addFile({ name: file.name, data: file, type: file.type }); }
  input.value = ''; pendingReplacement = null;
}
async function folderAction(folder: Folder, remove = false) {
  const name = remove ? folder.name : window.prompt('Nom du dossier', folder.name);
  if (!name || (remove && !window.confirm(`Supprimer le dossier vide « ${name} » ?`))) return;
  try { await api(remove ? 'DELETE' : 'PATCH', `/api/v1/folders/${folder.id}`, remove ? { revision: folder.revision } : { name, parentId: folder.parentId, revision: folder.revision }); await reload(); }
  catch (reason) { report(reason); }
}
function moveFolder(folder: Folder) {
  selectedFolder.value = folder; operation.value = 'folderMove'; destination.value = folder.parentId || 'root';
  modal.value?.showModal();
}
async function restoreVersion(id: string) {
  if (!selected.value || !window.confirm('Cette version redeviendra celle du lien pédagogique. Continuer ?')) return;
  try { await api('POST', `/api/v1/resources/${selected.value.id}/versions/${id}/restore`, { revision: selected.value.revision }); modal.value?.close(); await reload(); }
  catch (reason) { report(reason); }
}
async function revoke(id: string) { try { await api('DELETE', `/api/v1/service-accounts/${id}`); tokens.value = (await api('GET', '/api/v1/service-accounts')).items; } catch (reason) { report(reason); } }
async function logout() { try { await api('POST', '/auth/logout'); location.reload(); } catch (reason) { report(reason); } }
function placeMenu(event: Event) {
  const menu = event.target;
  if (!(menu instanceof HTMLDetailsElement) || !menu.classList.contains('menu') || !menu.open) return;
  for (const other of document.querySelectorAll<HTMLDetailsElement>('.menu[open]')) if (other !== menu) other.open = false;
  const panel = menu.querySelector('div'), anchor = menu.querySelector('summary');
  if (!panel || !anchor) return;
  const bounds = anchor.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, bounds.right - panel.offsetWidth))}px`;
  panel.style.top = `${Math.max(8, Math.min(innerHeight - panel.offsetHeight - 8, bounds.bottom + 5))}px`;
}
function closeMenus(event: Event) {
  const target = event.target as Element | null;
  if (event.type === 'click' && target?.closest?.('summary')) return;
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('.menu[open]')) menu.open = false;
}
function keyMenus(event: KeyboardEvent) { if (event.key === 'Escape') closeMenus(event); }
async function initialize() {
  loading.value = true;
  try {
    const publicConfig = await api('GET', '/api/public-config'); moodleUrl.value = publicConfig.moodleUrl;
    profile.value = await api<Profile>('GET', '/api/v1/me');
    await nextTick(); setupUploader(); await reload();
  } catch (reason) { if (!(reason instanceof ApiError && reason.status === 401)) report(reason); }
  finally { loading.value = false; }
}
async function regainFocus() { if (profile.value) { try { profile.value = await api('GET', '/api/v1/me'); } catch (reason) { report(reason); } } }
onMounted(() => { void initialize(); timer = setInterval(() => { void refreshTransfers(); }, 3000); window.addEventListener('focus', regainFocus); document.addEventListener('toggle', placeMenu, true); document.addEventListener('click', closeMenus); document.addEventListener('keydown', keyMenus); });
onBeforeUnmount(() => { clearInterval(timer); clearTimeout(debounce); window.removeEventListener('focus', regainFocus); document.removeEventListener('toggle', placeMenu, true); document.removeEventListener('click', closeMenus); document.removeEventListener('keydown', keyMenus); uppy?.destroy(); for (const worker of hashWorkers.values()) worker.terminate(); });
</script>

<template>
  <a class="skip-link" href="#main">Aller au contenu</a>
  <header class="topbar"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">▤</span><span>MProvi<span class="brand-light">Files</span></span></a>
    <div class="top-actions"><a v-if="moodleUrl" :href="moodleUrl" class="moodle-link">↗ {{ text.moodle }}</a><span v-if="profile" class="avatar" aria-hidden="true">{{ profile.name.slice(0, 1) }}</span><span v-if="profile" class="user-name">{{ profile.name }}</span><button v-if="profile" class="quiet" @click="logout">{{ text.logout }}</button></div>
  </header>
  <div v-if="notice" class="toast" role="status">✓ {{ notice }}</div>
  <div v-if="error" class="error-banner" role="alert"><span>{{ error }}</span><a href="/auth/moodle/start" target="_blank" rel="noopener">{{ text.login }}</a><button class="quiet" aria-label="Fermer le message" @click="error = ''">×</button></div>
  <main v-if="!profile" id="main" class="login-page"><div class="login-card"><span class="eyebrow">MProviFileSharing</span><h1>{{ text.loginTitle }}</h1><p>{{ error ? text.accessDenied : text.loginHint }}</p><a class="button primary" href="/auth/moodle/start">{{ loading ? 'Connexion…' : text.login }}</a></div><div class="login-illustration" aria-hidden="true"><div class="sample-folder">▰</div><div class="sample-file">ISO <span>Ressources pédagogiques</span></div><div class="sample-file second">OVA <span>Machines virtuelles</span></div><span class="illustration-check">✓</span></div></main>
  <div v-else class="shell">
    <aside class="sidebar"><p class="section-label">ESPACE ENSEIGNANT</p><button class="nav-item" :class="{ active: !trash }" @click="trash = false; selectFolder(null)">▤ {{ text.catalogue }}</button><button class="nav-item" :class="{ active: trash }" @click="trash = true; selectFolder(null)">♲ {{ text.trash }}</button><button v-if="can('admin')" class="nav-item" @click="openOperation('tokens')">⚿ {{ text.admin }}</button>
      <div class="sidebar-title"><span>{{ text.folders }}</span><button v-if="can('upload')" class="quiet" :aria-label="text.newFolder" @click="openOperation('newFolder')">+</button></div>
      <button class="folder-link" :class="{ selected: current === null }" @click="selectFolder(null)">⌂ Racine</button><button v-for="folder in folders" :key="folder.id" class="folder-link" :class="{ selected: current === folder.id }" @click="selectFolder(folder.id)"><span aria-hidden="true">▱</span> {{ folder.name }}</button>
      <div class="storage"><div class="storage-heading"><span>◉ {{ text.used }}</span><strong>{{ formatSize(space.usedBytes) }}</strong></div><progress :value="usedPercent" max="100" :aria-label="text.used"></progress><p>{{ formatSize(space.availableBytes) }} {{ text.available }}</p><small>{{ formatSize(space.reservedBytes) }} {{ text.reserved }}</small></div>
    </aside>
    <main id="main" class="workspace">
      <div class="page-heading"><div><span class="eyebrow">BIBLIOTHÈQUE PARTAGÉE</span><h1>{{ trash ? text.trash : text.title }}</h1><p>{{ text.subtitle }}</p></div><div class="heading-actions"><button v-if="can('upload')" class="button secondary" @click="openOperation('newFolder')">+ {{ text.newFolder }}</button><button v-if="can('upload')" class="button primary" @click="showUploads = !showUploads">↑ {{ text.upload }}</button></div></div>
      <section v-show="showUploads" class="upload-panel" aria-label="Déposer des fichiers"><div ref="dashboard"></div><div class="upload-footer"><p>{{ text.resumeHint }}</p><button class="button primary" @click="startTransfers">Lancer les transferts</button></div></section>
      <div class="catalogue-tools"><label class="search"><span aria-hidden="true">⌕</span><input v-model="search" type="search" :placeholder="text.search" :aria-label="text.search"></label><label class="sort-label">Trier par <select v-model="sort"><option value="name">{{ text.name }}</option><option value="size">{{ text.size }}</option><option value="date">{{ text.modified }}</option><option value="type">Type</option></select></label><button class="icon-button" :aria-label="order === 'asc' ? 'Ordre décroissant' : 'Ordre croissant'" @click="order = order === 'asc' ? 'desc' : 'asc'">{{ order === 'asc' ? '↑' : '↓' }}</button><button class="icon-button" :aria-label="text.reload" @click="reload">↻</button></div>
      <nav class="breadcrumbs" aria-label="Fil d’Ariane"><button @click="selectFolder(null)">Ressources</button><template v-for="folder in breadcrumbs" :key="folder.id"><span aria-hidden="true">/</span><button :aria-current="current === folder.id ? 'page' : undefined" @click="selectFolder(folder.id)">{{ folder.name }}</button></template><span v-if="search">/ Résultats de recherche</span></nav>
      <section class="file-card" :aria-label="text.catalogue"><div class="table-scroll"><table><thead><tr><th>{{ text.name }}</th><th>{{ text.size }}</th><th>{{ text.author }}</th><th>{{ text.modified }}</th><th><span class="sr-only">{{ text.actions }}</span></th></tr></thead><tbody>
        <tr v-for="folder in (!search && !trash ? visibleFolders : [])" :key="folder.id" class="folder-row"><td><button class="file-name" @click="selectFolder(folder.id)"><span class="file-icon folder-icon" aria-hidden="true">▰</span>{{ folder.name }}</button></td><td class="muted">Dossier</td><td></td><td></td><td><details v-if="can('upload') && (folder.ownerId === profile.id || can('manageothers'))" class="menu"><summary aria-label="Actions sur le dossier">⋯</summary><div><button @click="folderAction(folder)">{{ text.rename }}</button><button @click="moveFolder(folder)">{{ text.move }}</button><button @click="folderAction(folder, true)">Supprimer le dossier vide</button></div></details></td></tr>
        <tr v-for="resource in rows" :key="resource.id" @contextmenu.prevent="openOperation('details', resource)"><td><button class="file-name" @click="openOperation('details', resource)"><span class="file-icon" :class="{ iso: resource.extension === 'iso', archive: ['zip','7z','tar'].includes(resource.extension) }" aria-hidden="true">{{ resource.extension.slice(0, 4).toUpperCase() || 'FILE' }}</span><span>{{ resource.name }}<small v-if="resource.availability !== 'ready'" class="status-label">{{ resource.availability === 'trashed' ? text.trashed : text.missing }}</small></span></button></td><td class="nowrap">{{ formatSize(resource.sizeBytes) }}</td><td><span class="mini-avatar" aria-hidden="true">{{ (resource.uploaderName || resource.ownerName || '?').slice(0, 1) }}</span>{{ resource.uploaderName || resource.ownerName }}</td><td class="muted nowrap">{{ date(resource.updatedAt) }}</td><td class="row-actions"><button v-if="!trash" class="icon-button" :aria-label="`${text.copy} : ${resource.name}`" @click="copyLink(resource)">⧉</button><details class="menu"><summary :aria-label="`${text.actions} : ${resource.name}`">⋯</summary><div><a v-if="!trash" :href="resource.downloadUrl">{{ text.download }}</a><button v-if="!trash" @click="copyLink(resource)">{{ text.copy }}</button><button v-if="!trash" @click="copyLink(resource, true)">{{ text.copyHtml }}</button><button @click="openOperation('details', resource)">{{ text.details }}</button><template v-if="canEdit(resource)"><button v-if="!trash" @click="openOperation('rename', resource)">{{ text.rename }}</button><button v-if="!trash" @click="openOperation('move', resource)">{{ text.move }}</button><button v-if="!trash" @click="replace(resource)">{{ text.replace }}</button><button @click="openOperation('versions', resource)">{{ text.versions }}</button><button v-if="trash" @click="openOperation('restore', resource)">{{ text.restore }}</button><button v-else class="danger" @click="openOperation('remove', resource)">{{ text.remove }}</button></template></div></details></td></tr>
      </tbody></table></div>
      <div v-if="!rows.length && (search || trash || !visibleFolders.length)" class="empty-state"><span aria-hidden="true">▤</span><h2>{{ search ? text.emptySearch : text.empty }}</h2><p v-if="!search && !trash">{{ text.emptyHint }}</p><button v-if="can('upload') && !trash" class="button secondary" @click="showUploads = true">{{ text.upload }}</button></div>
      <footer class="table-footer"><span>{{ rows.length }} ressource{{ rows.length > 1 ? 's' : '' }} · {{ text.shared }}</span><div><button class="quiet" :disabled="page === 1" @click="page--">← {{ text.previous }}</button><span>{{ page }}</span><button class="quiet" :disabled="!hasMore" @click="page++">{{ text.next }} →</button></div></footer></section>
      <section class="transfers"><div class="section-heading"><h2>{{ text.transfers }}</h2><span class="pill">{{ transfers.filter((t) => !['completed','cancelled','expired','error'].includes(t.state)).length }} actifs</span></div><p v-if="!transfers.length" class="muted">{{ text.noTransfers }}</p><div v-for="transfer in transfers.slice(0, 8)" :key="transfer.id" class="transfer-row"><span class="transfer-symbol" :class="{ done: transfer.state === 'completed' }" aria-hidden="true">{{ transfer.state === 'completed' ? '✓' : '↑' }}</span><div class="transfer-main"><strong>{{ transfer.name }}</strong><div class="muted"><span>{{ stateLabels[transfer.state] || transfer.state }}</span> · {{ formatSize(transfer.receivedBytes) }} / {{ formatSize(transfer.sizeBytes) }}</div><progress v-if="['uploading','reserved'].includes(transfer.state)" :value="Number(transfer.receivedBytes)" :max="Math.max(1, Number(transfer.sizeBytes))" :aria-label="`Progression de ${transfer.name}`"></progress></div><button v-if="['reserved','uploading','received','error'].includes(transfer.state)" class="quiet" @click="api('DELETE', `/api/v1/uploads/${transfer.id}`).then(refreshTransfers).catch(report)">{{ text.cancel }}</button></div><p v-if="Object.values(hashProgress).some((p) => p < 1)" class="muted">{{ text.hash }} en cours ; la publication attendra la comparaison des empreintes.</p></section>
    </main>
  </div>
  <input ref="chooser" class="sr-only" type="file" tabindex="-1" @change="chooseReplacement">
  <dialog ref="modal" class="modal"><form @submit.prevent="submitOperation"><div class="modal-heading"><h2>{{ ({newFolder:text.newFolder,rename:text.rename,move:text.move,folderMove:text.move,remove:text.remove,restore:text.restore,versions:text.versions,details:text.details,tokens:text.admin} as Record<string,string>)[operation] }}</h2><button class="quiet" type="button" :aria-label="text.close" @click="modal?.close()">×</button></div>
    <label v-if="['newFolder','rename','tokens'].includes(operation)" class="field">{{ text.name }}<input v-model="editName" :required="operation !== 'tokens'" maxlength="255" autofocus></label>
    <label v-if="['move','folderMove'].includes(operation)" class="field">Dossier de destination<select v-model="destination"><option value="root">Racine</option><option v-for="folder in folders" :key="folder.id" :value="folder.id">{{ folder.name }}</option></select></label>
    <div v-if="operation === 'remove'"><p>{{ text.deletedWarning }}</p><p>{{ usages }} sélection(s) Moodle connue(s). {{ text.usagesWarning }}</p></div>
    <p v-if="operation === 'restore'">Le lien pédagogique sera réactivé avec sa version conservée.</p>
    <dl v-if="operation === 'details' && selected" class="metadata"><dt>{{ text.name }}</dt><dd>{{ selected.name }}</dd><dt>{{ text.size }}</dt><dd>{{ formatSize(selected.sizeBytes) }}</dd><dt>{{ text.author }}</dt><dd>{{ selected.uploaderName || selected.ownerName }}</dd><dt>Date de dépôt</dt><dd>{{ date(selected.uploadedAt) }}</dd><dt>SHA-256</dt><dd class="hash-value">{{ selected.sha256 }}</dd><dt>Lien stable</dt><dd class="hash-value">{{ selected.downloadUrl }}</dd></dl>
    <div v-if="operation === 'versions'" class="versions"><div v-for="version in versions" :key="version.id"><div><strong>Version {{ version.number }}</strong><p class="muted">{{ formatSize(version.sizeBytes) }} · {{ version.purgedAt ? 'Contenu purgé' : 'Conservée' }}</p><code>{{ version.sha256 }}</code></div><button v-if="!version.purgedAt && version.id !== selected?.currentVersionId" type="button" class="button secondary" @click="restoreVersion(version.id)">{{ text.restore }}</button></div></div>
    <div v-if="operation === 'tokens'"><div v-if="freshToken" class="token-result"><p>{{ text.tokenHint }}</p><code>{{ freshToken }}</code></div><ul class="token-list"><li v-for="item in tokens" :key="item.id"><span>{{ item.name }} · {{ item.revokedAt ? 'Révoqué' : date(item.expiresAt) }}</span><button v-if="!item.revokedAt" type="button" class="quiet danger" @click="revoke(item.id)">{{ text.revoke }}</button></li></ul></div>
    <footer class="modal-actions"><button type="button" class="button secondary" @click="modal?.close()">{{ text.close }}</button><button v-if="!['details','versions'].includes(operation)" class="button" :class="operation === 'remove' ? 'destructive' : 'primary'">{{ operation === 'tokens' ? text.createToken : operation === 'remove' ? text.remove : text.save }}</button></footer>
  </form></dialog>
</template>
