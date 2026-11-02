import test from 'node:test';
import assert from 'node:assert/strict';
import { signature, equals, sha256 } from '../../packages/core/src/security.ts';
import { loadConfig } from '../../packages/core/src/config.ts';
import { fileName } from '../../packages/core/src/errors.ts';
import { spawnSync } from 'node:child_process';

test('les signatures lient méthode, route, horodatage, nonce et octets exacts du corps', () => {
  const key = 'f0'.repeat(32), body = '{"subject":"42"}';
  const good = signature(key, 'POST', '/service', '1793650000', 'nonce', body);
  for (const wrong of [signature(key, 'GET', '/service', '1793650000', 'nonce', body),
    signature(key, 'POST', '/other', '1793650000', 'nonce', body),
    signature(key, 'POST', '/service', '1793650001', 'nonce', body),
    signature(key, 'POST', '/service', '1793650000', 'other', body),
    signature(key, 'POST', '/service', '1793650000', 'nonce', `${body} `)]) assert.notEqual(wrong, good);
  assert.ok(equals(good, good)); assert.equal(equals(good, ''), false);
});
test('les noms conservent Unicode mais refusent les chemins et en-têtes injectés', () => {
  assert.equal(fileName('debian-école.ova'), 'debian-école.ova');
  for (const bad of ['../escape', '..', 'vm\\disk', 'script\r\nInjected: true', 'trailing.', '\ud800', '<script>.iso']) {
    assert.throws(() => fileName(bad));
  }
});
test('la configuration de production refuse HTTP et les secrets réutilisés', () => {
  const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/db', APP_ORIGIN: 'https://files.example.test',
    MOODLE_ORIGIN: 'https://moodle.example.test', STORAGE_ROOT: '/srv/ressources', STORAGE_MARKER: '20745aef-d67e-41ae-9472-caf62114bd92',
    SESSION_SECRET: sha256('session'), MOODLE_SHARED_SECRET: sha256('sso'), MOODLE_CATALOG_SECRET: sha256('catalogue') };
  assert.equal(loadConfig(env).secureCookies, true);
  assert.throws(() => loadConfig({ ...env, APP_ORIGIN: 'http://files.example.test' }));
  assert.throws(() => loadConfig({ ...env, MOODLE_CATALOG_SECRET: env.MOODLE_SHARED_SECRET }));
  assert.throws(() => loadConfig({ ...env, APP_ORIGIN: 'https://files.example.test/redirect' }));
  assert.throws(() => loadConfig({ ...env, SESSION_SECRET: 'a'.repeat(65) }));
});
test('interopérabilité PHP/Node : même empreinte HMAC sur les octets UTF-8', (t) => {
  const php = process.env.PHP_BINARY || 'php';
  const result = spawnSync(php, ['-n', 'tests/moodle/bridge.php'], { encoding: 'utf8' });
  if (result.error && !process.env.CI && !process.env.PHP_BINARY) { t.skip('PHP indisponible sur ce poste ; exécuté sur Debian et en CI.'); return; }
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, signature('f0'.repeat(32), 'POST', '/service', '1793650000', 'nonce', '{"subject":"42","name":"école"}'));
});
