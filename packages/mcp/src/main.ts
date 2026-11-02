import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const base = new URL(process.env.FILESHARING_BASE_URL || 'https://invalid.example');
const credential = process.env.FILESHARING_API_TOKEN || '';
if (base.username || base.password || base.pathname !== '/' || base.search || base.hash || !/^[A-Za-z0-9_-]{43}$/.test(credential)
  || (base.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)))) {
  throw new Error('Configurer FILESHARING_BASE_URL en HTTPS et FILESHARING_API_TOKEN avec un compte de lecture dédié.');
}
async function request(path: string) {
  const response = await fetch(`${base.origin}/api/v1${path}`, { headers: { Authorization: `Bearer ${credential}` },
    redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Le catalogue a refusé la requête (${response.status}). Vérifiez les portées et l’expiration du compte technique.`);
  if (!response.body) throw new Error('Réponse vide.');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1048576) throw new Error('Réponse trop volumineuse ; réduire la pagination.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server = new McpServer({ name: 'mprovifilesharing', version: '0.1.0' });
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const output = async (operation: () => Promise<unknown>) => {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation()) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Catalogue indisponible.' }] }; }
};
server.registerTool('resources_search', {
  description: 'Rechercher des ressources pédagogiques. Vérifier leur disponibilité avant insertion dans Moodle.', annotations,
  inputSchema: { query: z.string().max(200), folderId: z.uuid().optional(), page: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(200).default(50) },
}, async ({ query, folderId, page, limit }) => output(() => request(`/resources?${new URLSearchParams({ q: query, page: String(page), limit: String(limit), ...(folderId ? { folderId } : {}) })}`)));
server.registerTool('resources_get', { description: 'Consulter les métadonnées d’une ressource.', annotations, inputSchema: { resourceId: z.uuid() } },
  async ({ resourceId }) => output(() => request(`/resources/${resourceId}`)));
server.registerTool('resources_check_availability', { description: 'Vérifier la disponibilité réelle du contenu.', annotations, inputSchema: { resourceId: z.uuid() } },
  async ({ resourceId }) => output(() => request(`/resources/${resourceId}/availability`)));
server.registerTool('resources_get_download_link', {
  description: 'Obtenir un lien stable et son libellé Moodle, après vérification de disponibilité. Le téléchargement exige une session Moodle active.',
  annotations, inputSchema: { resourceId: z.uuid() },
}, async ({ resourceId }) => output(async () => {
  if (!(await request(`/resources/${resourceId}/availability`)).available) throw new Error('Cette ressource est indisponible. Ne pas insérer son lien dans une nouvelle activité.');
  return request(`/resources/${resourceId}/link`);
}));
server.registerTool('folders_list', { description: 'Lister les dossiers du catalogue partagé.', annotations, inputSchema: { parentId: z.uuid().optional() } },
  async ({ parentId }) => output(() => request(`/folders${parentId ? `?parentId=${parentId}` : ''}`)));
await server.connect(new StdioServerTransport());
