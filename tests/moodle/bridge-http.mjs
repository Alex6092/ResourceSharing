import assert from 'node:assert/strict';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { readFile, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

const [php, work] = process.argv.slice(2), origin = 'http://127.0.0.1:3458';
const fixture = JSON.parse(await readFile(join(work, 'bridge-test.json'), 'utf8'));
const log = await open(join(work, 'php-http.log'), 'wx', 0o600);
const server = spawn(php, ['-S', '127.0.0.1:3458', '-t', join(work, 'source/public')], {
  detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, PHP_CLI_SERVER_WORKERS: '2' },
});
let catalogue;
const path = '/local/filesharing/service.php';
async function call(body, replayHeaders) {
  const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(32).toString('base64url');
  const headers = replayHeaders || { 'Content-Type': 'application/json', 'X-Client-Id': 'mprovifilesharing', 'X-Key-Id': 'v1',
    'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': createHmac('sha256', Buffer.from(fixture.secret, 'hex'))
      .update(['POST', path, timestamp, nonce, createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex') };
  const response = await fetch(origin + path, { method: 'POST', headers, body: raw });
  return { status: response.status, value: await response.json(), headers };
}
const exchange = (name) => ({ action: 'exchange', ...fixture.codes[name], clientId: 'mprovifilesharing', redirectUri: 'http://127.0.0.1:5174/auth/moodle/callback' });
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(origin + '/login/index.php')).status === 200) { ready = true; break; } } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Isolated PHP server must start.');
  const status = await call({ action: 'status', subject: fixture.subject });
  assert.equal(status.status, 200); assert.ok(status.value.active); assert.ok(status.value.capabilities.includes('upload'));
  assert.equal((await call({ action: 'status', subject: fixture.subject }, status.headers)).status, 401);
  const concurrent = await Promise.all([call(exchange('valid')), call(exchange('valid'))]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 403]);
  assert.equal((await call(exchange('valid'))).value.code, 'CODE_USED');
  assert.equal((await call(exchange('expired'))).value.code, 'CODE_EXPIRED');
  const badProof = exchange('proof'); badProof.verifier = randomBytes(32).toString('base64url');
  assert.equal((await call(badProof)).value.code, 'INVALID_PROOF');
  assert.equal((await call(exchange('proof'))).status, 200);
  if (process.env.MOODLE_QA_BROWSER === '1') {
    const requests = [];
    catalogue = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const raw = Buffer.concat(chunks), body = JSON.parse(raw);
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/api/v1/integrations/moodle/catalogue');
        assert.equal(body.subject, fixture.subject);
        const signature = createHmac('sha256', Buffer.from(fixture.catalogSecret, 'hex'))
          .update(['POST', request.url, request.headers['x-timestamp'], request.headers['x-nonce'], createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
        assert.equal(request.headers['x-signature'], signature);
        requests.push(body.action);
        const value = body.action === 'folders' ? { items: [] } : body.action === 'list'
          ? { items: [{ id: fixture.resourceId, name: 'Debian — atelier & réseau.iso', availability: 'ready' }], hasMore: false, total: 1 }
          : body.action === 'usage' ? { url: `http://127.0.0.1:5174/download/${fixture.resourceId}`, label: 'Télécharger Debian <atelier> & VM' } : null;
        assert.ok(value, 'Unexpected catalogue action');
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
      } catch (error) { response.writeHead(500); response.end('Qualification catalogue failed.'); console.error(error.message); }
    });
    await new Promise((resolve) => catalogue.listen(5174, '127.0.0.1', resolve));
    const browser = spawn(process.execPath, ['tests/moodle/editor-browser.mjs', join(work, 'bridge-test.json')], { stdio: 'inherit' });
    const timeout = setTimeout(() => browser.kill('SIGTERM'), 180000);
    try { const [code] = await once(browser, 'exit'); assert.equal(code, 0, 'Real Moodle Tiny browser test must pass.'); }
    finally { clearTimeout(timeout); }
    assert.ok(requests.includes('list') && requests.includes('folders') && requests.includes('usage'));
  }
  const reportPath = process.env.MOODLE_QA_REPORT;
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.status = 'passed';
  report.checks.push('real PHP HTTP HMAC and nonce replay', 'concurrent one-use code consumption', 'expiration and PKCE');
  if (process.env.MOODLE_QA_BROWSER === '1') report.checks.push('real TinyMCE toolbar/menu, signed Moodle AJAX catalogue, modal and escaped link insertion');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log('OK Moodle PHP HTTP : droits réels, HMAC, nonce, échange concurrent unique, expiration et PKCE.');
} finally {
  if (catalogue) await new Promise((resolve) => catalogue.close(resolve));
  if (server.pid) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already stopped */ } }
  await log.close();
}
