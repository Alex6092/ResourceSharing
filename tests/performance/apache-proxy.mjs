// Exercise the actual deployment templates under an unprivileged Apache process.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, request } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';

const work = await mkdtemp(join(tmpdir(), 'mprovi-proxy-'));
const report = { status: 'running', checks: [] };
let apache;
const backend = createServer(async (req, res) => {
  if (req.url === '/download/test') {
    res.writeHead(200, { 'X-Sendfile': join(work, 'storage/objects/object'), 'Content-Type': 'application/octet-stream' });
    res.end(); return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ headers: req.headers, method: req.method, body: Buffer.concat(chunks).toString() }));
});
function http(port, path, { peer = '127.0.0.2', headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, localAddress: peer, method,
      headers: { Host: 'files.tspro.fr', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Délai HTTP dépassé')));
    req.on('error', reject); req.end(body);
  });
}
function check(name) { report.checks.push(name); console.log(`OK ${name}`); }
try {
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const apiPort = backend.address().port;
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  for (const folder of ['web', 'storage/objects', 'logs']) await mkdir(join(work, folder), { recursive: true });
  await writeFile(join(work, 'web/index.html'), 'test proxy');
  await writeFile(join(work, 'storage/objects/object'), '0123456789');
  let common = await readFile('deploy/apache/mprovifilesharing.common.conf.template', 'utf8');
  common = common.replaceAll('/opt/mprovifilesharing/current/apps/web/dist', `${work}/web`)
    .replaceAll('/opt/mprovifilesharing/', `${work}/web/`)
    .replaceAll('/srv/ressources', `${work}/storage`)
    .replaceAll('/var/log/apache2', `${work}/logs`)
    .replaceAll('127.0.0.1:3000', `127.0.0.1:${apiPort}`);
  await writeFile(join(work, 'common.conf'), common);
  const proxy = (await readFile('deploy/apache/mprovifilesharing.proxy.conf.template', 'utf8'))
    .replaceAll('*:80', `127.0.0.1:${port}`).replaceAll('__HOST__', 'files.tspro.fr')
    .replaceAll('__PROXY_IP__', '127.0.0.2')
    .replaceAll('/etc/apache2/mprovifilesharing-common.conf', `${work}/common.conf`);
  const modules = ['mpm_event', 'authz_core', 'authz_host', 'headers', 'proxy', 'proxy_http', 'xsendfile', 'reqtimeout', 'setenvif', 'alias', 'dir', 'mime'];
  await writeFile(join(work, 'httpd.conf'), `ServerRoot "${work}"
DefaultRuntimeDir "${work}"
PidFile "${work}/pid"
Listen 127.0.0.1:${port}
ServerName localhost
User ${userInfo().username}
Group ${execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim()}
${modules.map((m) => `LoadModule ${m}_module /usr/lib/apache2/modules/mod_${m}.so`).join('\n')}
TypesConfig /etc/mime.types
DirectoryIndex index.html
StartServers 1
ServerLimit 1
ThreadsPerChild 25
MaxRequestWorkers 25
ErrorLog "${work}/logs/global-error.log"
# Test-only alias: filesystem deny must survive the proxy Location restriction.
Alias /forbidden/ "${work}/storage/objects/"
${proxy}
`);
  apache = spawn('/usr/sbin/apache2', ['-f', join(work, 'httpd.conf'), '-DFOREGROUND'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  apache.stderr.on('data', (chunk) => { errors += String(chunk); });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { const r = await http(port, '/index.html'); if (r.status === 200) { ready = true; break; } } catch {}
    if (apache.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, errors + '\n' + await readFile(join(work, 'logs/global-error.log'), 'utf8').catch(() => ''));
  check('templates réels : statique accessible depuis le proxy autorisé');
  const denied = await http(port, '/api/test', { peer: '127.0.0.1', headers: { 'X-Forwarded-For': '127.0.0.2', Forwarded: 'for=127.0.0.2', 'X-Forwarded-Proto': 'https' } });
  assert.equal(denied.status, 403);
  check('connexion directe refusée malgré des en-têtes de proxy falsifiés');
  const response = await http(port, '/api/test', { headers: { 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'evil.test', 'X-Sendfile': '/etc/passwd', Forwarded: 'for=evil' } });
  assert.equal(response.status, 200);
  const forwarded = JSON.parse(response.body);
  assert.equal(forwarded.headers.host, 'files.tspro.fr');
  assert.equal(forwarded.headers['x-forwarded-proto'], 'https');
  assert.equal(forwarded.headers['x-forwarded-host'], 'files.tspro.fr'); // added by mod_proxy
  assert.equal(forwarded.headers['x-sendfile'], undefined);
  assert.equal(forwarded.headers.forwarded, undefined);
  check('Host public conservé ; HTTPS imposé ; en-têtes internes entrants supprimés');
  const patch = await http(port, '/tus/test', { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream' }, body: 'raw tus bytes' });
  assert.equal(patch.status, 200);
  assert.equal(JSON.parse(patch.body).body, 'raw tus bytes');
  check('PATCH tus transmis sans altération du corps');
  const file = await http(port, '/download/test', { headers: { Range: 'bytes=2-5' } });
  assert.equal(file.status, 206);
  assert.equal(file.headers['content-range'], 'bytes 2-5/10');
  assert.equal(file.body.toString(), '2345');
  assert.equal(file.headers['x-sendfile'], undefined);
  check('X-Sendfile et Range : octets servis par Apache, en-tête interne absent');
  assert.equal((await http(port, '/forbidden/object')).status, 403);
  check('restriction disque conservée après fusion des autorisations du proxy');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message;
  throw error;
} finally {
  if (apache && apache.exitCode === null) { const exit = once(apache, 'exit'); apache.kill('SIGTERM'); await exit; }
  await new Promise((resolve) => backend.close(resolve));
  try {
    const destination = process.env.PROXY_REPORT_PATH || 'test-results/apache-proxy.json';
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify(report, null, 2));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
