import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';

const [php, work] = process.argv.slice(2), url = new URL(process.env.DATABASE_URL);
if (!php || !work || !/^\/mprovi_test_/.test(url.pathname)) throw new Error('Fresh qualification environment required.');
const pool = new pg.Pool({ connectionString: url.href });
try { await pool.query('CREATE DATABASE mprovi_test_moodle'); } finally { await pool.end(); }
const password = 'Qa-7' + randomBytes(24).toString('hex');
const log = await open(join(work, 'install.log'), 'wx', 0o600);
const args = [join(work, 'source/admin/cli/install.php'), '--wwwroot=http://127.0.0.1:3458', '--dataroot=' + join(work, 'data'),
  '--dbtype=pgsql', '--dbhost=' + (url.searchParams.get('host') || url.hostname), '--dbname=mprovi_test_moodle',
  '--dbuser=' + decodeURIComponent(url.username), '--dbpass=' + decodeURIComponent(url.password), '--dbport=' + (url.port || '5432'),
  '--lang=en', '--fullname=Isolated Moodle filesharing qualification', '--shortname=MProviQA',
  '--adminuser=qaadmin', '--adminpass=' + password, '--adminemail=qa@example.invalid', '--non-interactive', '--agree-license', '--chmod=0700'];
const installed = spawnSync(php, args, { stdio: ['ignore', log.fd, log.fd], timeout: 600000 });
await log.close();
if (installed.status !== 0) {
  console.error((await readFile(join(work, 'install.log'), 'utf8')).split('\n').slice(-40).join('\n'));
  throw new Error('Moodle installation failed.');
}
const checked = spawnSync(php, [resolve('tests/moodle/installed.php')], { stdio: 'inherit',
  env: { ...process.env, MOODLE_QA_ROOT: join(work, 'source') } });
if (checked.status !== 0) throw new Error('Moodle plugin contract verification failed.');
const http = spawnSync(process.execPath, ['tests/moodle/bridge-http.mjs', php, work], { stdio: 'inherit', env: process.env, timeout: 60000 });
if (http.status !== 0) throw new Error('Moodle real HTTP bridge verification failed.');
