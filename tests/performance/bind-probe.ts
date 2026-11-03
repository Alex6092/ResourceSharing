import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Storage } from '../../packages/core/src/storage.ts';
import { loadConfig } from '../../packages/core/src/config.ts';

const config = loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://files.example.test', MOODLE_ORIGIN: 'https://moodle.example.test',
  DATABASE_URL: 'not-connected-in-this-test', STORAGE_MODE: 'bind', STORAGE_ROOT: process.env.BIND_QA_TARGET,
  STORAGE_BIND_SOURCE: process.env.BIND_QA_SOURCE, STORAGE_MARKER: process.env.BIND_QA_MARKER,
  SESSION_SECRET: randomBytes(32).toString('hex'), MOODLE_SHARED_SECRET: randomBytes(32).toString('hex'), MOODLE_CATALOG_SECRET: randomBytes(32).toString('hex') });
const storage = new Storage(config), stage = process.env.BIND_QA_STAGE;
if (stage === 'missing') {
  await assert.rejects(storage.ready(), { code: 'STORAGE_UNAVAILABLE' });
} else {
  await storage.ready();
  if (stage === 'readonly') {
    const id = randomUUID();
    await writeFile(join(config.STORAGE_ROOT, 'incoming', id), 'ok');
    await unlink(join(config.STORAGE_ROOT, 'incoming', id));
    await assert.rejects(writeFile(join(config.STORAGE_ROOT, 'objects', id), 'refused'), { code: 'EROFS' });
  }
}
console.log(JSON.stringify({ stage, status: 'passed' }));
