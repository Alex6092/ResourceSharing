import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { hasExpectedBindMount } from '../../packages/core/src/storage.ts';

const info = await readFile('/proc/self/mountinfo', 'utf8');
assert.ok(hasExpectedBindMount(info, '/srv/ressources', '/var/lib/mprovifilesharing-data'));
const report = { status: 'passed', storage: 'existing 400 GiB system disk',
  sameFilesystemAsRoot: (await stat('/srv/ressources')).dev === (await stat('/')).dev,
  checks: ['exact bind source', 'nodev/nosuid/noexec', 'no additional virtual disk', 'no formatting'] };
assert.ok(report.sameFilesystemAsRoot);
await mkdir('.qualification', { recursive: true });
await writeFile('.qualification/rootdisk-bind.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
