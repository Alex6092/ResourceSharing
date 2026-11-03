import assert from 'node:assert/strict';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { readFile, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const [php, work] = process.argv.slice(2), origin = 'http://127.0.0.1:3458';
const fixture = JSON.parse(await readFile(join(work, 'bridge-test.json'), 'utf8'));
const log = await open(join(work, 'php-http.log'), 'wx', 0o600);
const server = spawn(php, ['-S', '127.0.0.1:3458', '-t', join(work, 'source/public')], {
  detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, PHP_CLI_SERVER_WORKERS: '2' },
});
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
  const reportPath = process.env.MOODLE_QA_REPORT;
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.status = 'passed';
  report.checks.push('real PHP HTTP HMAC and nonce replay', 'concurrent one-use code consumption', 'expiration and PKCE');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log('OK Moodle PHP HTTP : droits réels, HMAC, nonce, échange concurrent unique, expiration et PKCE.');
} finally {
  if (server.pid) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already stopped */ } }
  await log.close();
}
