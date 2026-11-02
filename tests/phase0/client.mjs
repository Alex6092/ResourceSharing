import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export async function startServer(fixture, options = {}) {
  const argumentsForNode = [fileURLToPath(new URL('./server.mjs', import.meta.url))];
  const child = spawn(options.runAs ? 'runuser' : process.execPath,
    options.runAs ? ['-u', options.runAs, '--', process.execPath, ...argumentsForNode] : argumentsForNode, {
    env: {
      ...process.env, PHASE0_FIXTURE_ONLY: '1', PHASE0_ROOT: fixture.root,
      PHASE0_MARKER: fixture.marker, PHASE0_PORT: String(options.port || 0),
      PHASE0_PUBLIC_ORIGIN: options.publicOrigin || '',
      PHASE0_DATABASE_URL: options.databaseUrl || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  let diagnostics = '';
  const failed = new Promise((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Serveur de test arrêté (${code}). ${diagnostics}`)));
  });
  const ready = new Promise((resolve) => child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.includes('\n')) {
      try { resolve(JSON.parse(output.slice(0, output.indexOf('\n')))); } catch { /* attendre une ligne complète */ }
    }
  }));
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-2000); });
  let deadline;
  try {
    const info = await Promise.race([
      ready, failed,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Démarrage du serveur trop long.')), 10000); }),
    ]);
    return { child, processPid: info.pid, origin: `http://127.0.0.1:${info.port}` };
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

export async function stopServer(server, crash = false) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = once(server.child, 'exit');
  process.kill(server.processPid || server.child.pid, crash ? 'SIGKILL' : 'SIGTERM');
  let deadline;
  const result = await Promise.race([exited, new Promise((resolve) => { deadline = setTimeout(() => resolve(false), 5000); })]);
  clearTimeout(deadline);
  if (result === false) {
    process.kill(server.processPid || server.child.pid, 'SIGKILL');
    await exited;
  }
}

export const auth = (identity) => ({ Authorization: `Bearer ${identity.token}` });

export async function createUpload(origin, identity, size, metadata = '') {
  return fetch(`${origin}/tus/uploads`, {
    method: 'POST', headers: {
      ...auth(identity), 'Tus-Resumable': '1.0.0', 'Upload-Length': String(size),
      ...(metadata ? { 'Upload-Metadata': metadata } : {}),
    }, body: null,
  });
}

export async function patchUpload(url, identity, offset, data) {
  return fetch(url, { method: 'PATCH', headers: {
    ...auth(identity), 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset),
    'Content-Type': 'application/offset+octet-stream',
  }, body: data });
}

export async function responseDigest(response) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest('hex') };
}
