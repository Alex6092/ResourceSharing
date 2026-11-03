import test from 'node:test';
import assert from 'node:assert/strict';
import { hasExpectedBindMount } from '../../packages/core/src/storage.ts';

test('le stockage lié exige la source exacte, le point de montage et les trois protections', () => {
  const valid = '43 25 254:1 /var/lib/mprovifilesharing-data /srv/ressources rw,nosuid,nodev,noexec,relatime - ext4 /dev/vda1 rw';
  assert.equal(hasExpectedBindMount(valid, '/srv/ressources', '/var/lib/mprovifilesharing-data'), true);
  for (const invalid of [valid.replace('/var/lib/mprovifilesharing-data', '/srv/ressources'), valid.replace(',noexec', ''),
    valid.replace('/srv/ressources', '/srv/autre'), '25 1 254:1 / / rw - ext4 /dev/vda1 rw', '']) {
    assert.equal(hasExpectedBindMount(invalid, '/srv/ressources', '/var/lib/mprovifilesharing-data'), false);
  }
});
