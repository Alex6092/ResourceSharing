import { PgBoss } from 'pg-boss';
import type { PoolClient } from 'pg';
import type { Config } from './config.ts';

export function queue(config: Config, initialize = false) {
  const boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: 'pgboss',
    max: 4, migrate: initialize, supervise: initialize });
  boss.on('error', () => { console.error('Erreur de la file de tâches ; consulter son état.'); });
  return boss;
}
export async function initializeQueue(config: Config) {
  const boss = queue(config, true);
  await boss.start();
  await boss.createQueue('validate-upload', { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 86400 });
  await boss.stop();
}
export const inTransaction = (client: PoolClient) => ({
  executeSql: (text: string, values?: unknown[]) => client.query(text, values),
});
