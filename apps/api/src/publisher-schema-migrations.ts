import type {D1Database} from '@cloudflare/workers-types';
import initial from '../../../infra/migrations/0001-local-publisher.sql';
import authority from '../../../infra/migrations/0003-local-publisher-authority.sql';
import versions from '../../../infra/migrations/0002-local-package-versions.sql';
import {encodeBase64Url} from '../../../packages/protocol/src/index.js';
import {fail} from './publisher-storage-errors.js';

// Additive local migrations only. Released SQL is immutable; every checksum is
// confirmed after the transactional batch, including concurrent initialization.
export const migratePublisherSchema = async (db: D1Database): Promise<void> => {
  await db.prepare('CREATE TABLE IF NOT EXISTS publisher_schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL)').run();
  const applied = await db.prepare('SELECT version,checksum FROM publisher_schema_migrations ORDER BY version').all<{version: number; checksum: string}>();
  const migrations = [initial, versions, authority];
  if (applied.results.some((row, index) => row.version !== index + 1) || applied.results.length > migrations.length) fail(503, 'PUBLISHER_SCHEMA_INVALID');
  for (const [index, sql] of migrations.entries()) {
    const version = index + 1;
    const checksum = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sql))));
    const existing = applied.results[index];
    if (existing && existing.checksum !== checksum) fail(503, 'PUBLISHER_SCHEMA_INVALID');
    if (!existing) await db.batch([
      ...sql.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)),
      db.prepare('INSERT INTO publisher_schema_migrations(version,checksum) VALUES(?,?) ON CONFLICT DO NOTHING').bind(version, checksum),
    ]);
    const committed = await db.prepare('SELECT checksum FROM publisher_schema_migrations WHERE version=?').bind(version).first<{checksum: string}>();
    if (committed?.checksum !== checksum) fail(503, 'PUBLISHER_SCHEMA_INVALID');
  }
};
