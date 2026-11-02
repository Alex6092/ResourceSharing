import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Pool } from 'pg';
import { transaction, lockKey } from './db.ts';

export function accessRecord(line: string) {
  const match = /^(\d{4}-\d{2}-\d{2}) (GET|HEAD) \/download\/([0-9a-f-]{36})(?:\/versions\/[0-9a-f-]{36})? (\d{3}) (\d+|-)$/.exec(line);
  if (!match || !Number.isFinite(Date.parse(match[1])) || new Date(match[1]).toISOString().slice(0, 10) !== match[1]
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(match[3])) return null;
  return { day: match[1], resourceId: match[3], status: Number(match[4]), bytes: BigInt(match[5] === '-' ? '0' : match[5]) };
}
export async function importAccessLog(pool: Pool, path: string) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Journal Apache régulier requis.');
    const fileId = `${stat.dev}:${stat.ino}`;
    await transaction(pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey('mprovi:log:' + fileId)]);
      const cursor = (await db.query('SELECT byte_offset FROM http_log_cursors WHERE file_id=$1', [fileId])).rows[0];
      let offset = Number(cursor?.byte_offset || 0);
      if (offset > stat.size) offset = 0;
      let position = offset, carry = Buffer.alloc(0);
      const records = new Map<string, { day: string; resourceId: string; requests: bigint; bytes: bigint; errors: bigint }>();
      const block = Buffer.alloc(65536), maximum = Math.min(stat.size, offset + 16 * 1024 ** 2);
      while (position < maximum) {
        const { bytesRead } = await file.read(block, 0, Math.min(block.length, maximum - position), position);
        if (!bytesRead) break;
        position += bytesRead;
        const data = Buffer.concat([carry, block.subarray(0, bytesRead)]);
        let start = 0, end;
        while ((end = data.indexOf(10, start)) !== -1) {
          const record = accessRecord(data.subarray(start, end).toString('utf8'));
          offset += end - start + 1; start = end + 1;
          if (!record) continue;
          const key = record.day + ':' + record.resourceId;
          const aggregate = records.get(key) || { ...record, requests: 0n, bytes: 0n, errors: 0n };
          aggregate.requests++; aggregate.bytes += record.bytes; aggregate.errors += record.status >= 400 ? 1n : 0n;
          records.set(key, aggregate);
        }
        carry = Buffer.from(data.subarray(start));
        if (carry.length > 65536) throw new Error('Ligne Apache trop longue.');
      }
      for (const record of records.values()) await db.query(`INSERT INTO download_aggregates(day,resource_id,requests,bytes_sent,errors)
        SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM resources WHERE id=$2)
        ON CONFLICT(day,resource_id) DO UPDATE SET requests=download_aggregates.requests+excluded.requests,
        bytes_sent=download_aggregates.bytes_sent+excluded.bytes_sent,errors=download_aggregates.errors+excluded.errors`,
      [record.day, record.resourceId, String(record.requests), String(record.bytes), String(record.errors)]);
      await db.query(`INSERT INTO http_log_cursors(file_id,byte_offset) VALUES($1,$2)
        ON CONFLICT(file_id) DO UPDATE SET byte_offset=excluded.byte_offset,updated_at=now()`, [fileId, String(offset)]);
      await db.query("DELETE FROM http_log_cursors WHERE updated_at<now()-interval '35 days'");
    });
  } finally { await file.close(); }
}
