import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyUploadedPackage} from '../apps/api/src/package-verifier.js';
import {createHash, randomBytes} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {Miniflare} from 'miniflare';
import type {D1Database, R2Bucket} from '@cloudflare/workers-types';
import {DurablePublisherStorage} from '../apps/api/src/durable-publisher-storage.js';
import {createSignedEnrollment} from '../packages/protocol/src/index.js';
import cases from '../packages/protocol/vectors/package-cases-v1.json';

beforeAll(async () => {
  try { await promisify(execFile)('cargo', ['build', '--locked', '-p', 'smallframe-cli'], {maxBuffer: 128_000}); }
  catch {throw new Error('NATIVE_FIXTURE_BUILD_FAILED');}
}, 120_000);

let miniflare: Miniflare | undefined;
let temporaryDirectory = '';
afterEach(async () => { await miniflare?.dispose(); miniflare = undefined;
  if (temporaryDirectory) await rm(temporaryDirectory, {recursive: true, force: true}); temporaryDirectory = ''; });
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64url');
const fixture = async () => {
  const root = resolve('.wrangler'); await mkdir(root, {recursive: true});
  temporaryDirectory = await mkdtemp(join(root, 'durable-publisher-'));
  const options = {d1Persist: join(temporaryDirectory, 'd1'), r2Persist: join(temporaryDirectory, 'r2'), modules: true, script: 'export default {fetch(){return new Response(null)}}',
    compatibilityDate: '2026-07-30', d1Databases: ['DB'], r2Buckets: ['PACKAGES']};
  miniflare = new Miniflare(options);
  const db = await miniflare.getD1Database('DB') as unknown as D1Database;
  const bucket = await miniflare.getR2Bucket('PACKAGES') as unknown as R2Bucket;
  let now = Date.now();
  const storage = new DurablePublisherStorage(db, bucket, () => now);
  await storage.initialize();
  // Public golden publisher only, with no token/secret or enrollment authority.
  const archive = Buffer.from((await readFile('packages/protocol/vectors/canonical-package-v1.zip.b64', 'utf8')).trim(), 'base64');
  let offset = 0; let publicKey = '';
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const size = archive.readUInt32LE(offset + 18); const nameSize = archive.readUInt16LE(offset + 26);
    const start = offset + 30 + nameSize + archive.readUInt16LE(offset + 28);
    if (archive.subarray(offset + 30, offset + 30 + nameSize).toString() === 'smallframe.json') {
      publicKey = (JSON.parse(archive.subarray(start, start + size).toString()) as {publisher: {publicKey: string}}).publisher.publicKey;
    }
    offset = start + size;
  }
  expect(`sha256:${hash(Buffer.from(publicKey, 'base64url'))}`).toBe(cases.canonical.publisherKeyId);
  await db.prepare('INSERT INTO publishers(id,public_key,key_id,created_at) VALUES(?,?,?,?)')
    .bind(cases.canonical.publisherKeyId, publicKey, cases.canonical.publisherKeyId, now).run();
  const advance = (ms: number) => { now += ms; };
  const enroll = async (inviteCodeHash = hash(randomBytes(24))) => {
    const signed = await createSignedEnrollment({publisherPrivateKey: randomBytes(32), tokenHash: randomBytes(32),
      operationId: randomBytes(16), inviteCodeHash: Buffer.from(inviteCodeHash, 'base64url')});
    await storage.createInvite({codeHash: inviteCodeHash, createdAt: now, expiresAt: now + 60_000});
    return {record: signed.record, digest: hash(signed.jcsBytes)};
  };
  const restart = async () => {
    await miniflare!.dispose(); miniflare = new Miniflare(options);
    return new DurablePublisherStorage(await miniflare.getD1Database('DB') as unknown as D1Database,
      await miniflare.getR2Bucket('PACKAGES') as unknown as R2Bucket, () => now);
  };
  return {storage, db, bucket, advance, enroll, restart};
};
const packageRecord = async () => {
  const bytes = Buffer.from((await readFile('packages/protocol/vectors/canonical-package-v1.zip.b64', 'utf8')).trim(), 'base64');
  return {bytes: new Uint8Array(bytes), packageDigest: cases.canonical.packageDigest,
    artifactDigest: cases.canonical.artifactDigest, publisherKeyId: cases.canonical.publisherKeyId,
    byteLength: bytes.length, createdAt: Date.now()};
};

describe('real local D1/R2 publisher durability and fault boundaries', () => {
  it('retains exact enrollment replay across new storage instances and beyond 24h, then rejects revoked authority', async () => {
    const {storage, advance, enroll, restart} = await fixture();
    const {record, digest} = await enroll();
    const result = await storage.enroll(record, digest);
    expect(result.created).toBe(true);
    advance(2 * 86_400_000);
    await storage.cleanup();
    const restarted = await restart();
    expect(await restarted.replayEnrollment(record, digest)).toBe(result.body);
    expect(await restarted.publisher(record.tokenHash)).not.toBeNull();
    await expect(restarted.replayEnrollment(record, hash(randomBytes(32)))).rejects.toMatchObject({code: 'IDEMPOTENCY_MISMATCH'});
    await restarted.revoke(record.tokenHash);
    expect(await restarted.publisher(record.tokenHash)).toBeNull();
    await expect(restarted.replayEnrollment(record, digest)).rejects.toMatchObject({code: 'PUBLISHER_REVOKED'});
    advance(30 * 86_400_000 + 1);
    await restarted.cleanup();
    expect(await restarted.replayEnrollment(record, digest)).toBeNull();
    await expect(restarted.enroll(record, digest)).rejects.toMatchObject({code: 'INVITE_UNAVAILABLE'});
    expect(await restarted.publisher(record.tokenHash)).toBeNull();
  });

  it('consumes one invite atomically under competing enrollments and rolls back an interrupted batch', async () => {
    const {storage, db, bucket, enroll} = await fixture();
    const first = await enroll();
    const second = await enroll(first.record.inviteCodeHash);
    const results = await Promise.allSettled([storage.enroll(first.record, first.digest), storage.enroll(second.record, second.digest)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM publisher_enrollments').first<{count: number}>())?.count).toBe(1);
    const pending = await enroll();
    await db.prepare("CREATE TRIGGER enrollment_fault BEFORE INSERT ON publisher_enrollments BEGIN SELECT RAISE(ABORT,'SIMULATED_ENROLLMENT_FAULT'); END").run();
    await expect(new DurablePublisherStorage(db, bucket).enroll(pending.record, pending.digest)).rejects.toMatchObject({code: 'ENROLLMENT_CONFLICT'});
    expect(await storage.publisher(pending.record.tokenHash)).toBeNull();
    expect((await db.prepare('SELECT usedAt FROM publisher_invites WHERE codeHash=?').bind(pending.record.inviteCodeHash).first<{usedAt: number | null}>())?.usedAt).toBeNull();
    await db.prepare('DROP TRIGGER enrollment_fault').run();
    expect((await storage.enroll(pending.record, pending.digest)).created).toBe(true);
  });

  it('recovers a committed R2 put with a lost response without activating metadata early', async () => {
    const {storage, db, bucket} = await fixture();
    const record = await packageRecord(); const operation = randomBytes(16).toString('base64url'); const digest = hash(record.bytes);
    const interrupted = {head: bucket.head.bind(bucket), get: bucket.get.bind(bucket), put: async (...args: Parameters<R2Bucket['put']>) => {
      await bucket.put(...args); throw new Error('SIMULATED_LOST_PUT_CONFIRMATION');
    }} as unknown as R2Bucket;
    await expect(new DurablePublisherStorage(db, interrupted).upload(record, operation, digest)).rejects.toThrow('SIMULATED_LOST_PUT_CONFIRMATION');
    expect(await storage.package(record.packageDigest)).toBeNull();
    const restarted = new DurablePublisherStorage(db, bucket);
    expect(await restarted.reconcile()).toEqual({activated: 1, pending: 0});
    expect((await restarted.package(record.packageDigest))?.bytes).toEqual(record.bytes);
    const replay = await restarted.upload(record, operation, digest);
    expect(replay.created).toBe(false);
    await db.prepare('UPDATE publisher_upload_operations SET responseBody=? WHERE operationId=?').bind('{}', operation).run();
    await expect(restarted.upload(record, operation, digest)).rejects.toMatchObject({code: 'PACKAGE_OPERATION_INVALID'});
    await db.prepare('UPDATE publisher_upload_operations SET responseBody=? WHERE operationId=?').bind(replay.body, operation).run();
    await expect(restarted.upload(record, operation, hash(randomBytes(32)))).rejects.toMatchObject({code: 'IDEMPOTENCY_MISMATCH'});
    expect(await restarted.reconcile()).toEqual({activated: 0, pending: 0});
  });

  it('retains R2_PRESENT after an interrupted activation transaction and converges concurrent exact replay', async () => {
    const {storage, db, bucket} = await fixture();
    const record = await packageRecord(); const operation = randomBytes(16).toString('base64url'); const digest = hash(record.bytes);
    await db.prepare("CREATE TRIGGER activation_fault BEFORE INSERT ON publisher_packages BEGIN SELECT RAISE(ABORT,'SIMULATED_ACTIVATION_FAULT'); END").run();
    await expect(new DurablePublisherStorage(db, bucket).upload(record, operation, digest)).rejects.toThrow();
    expect((await db.prepare('SELECT status FROM app_versions WHERE package_digest=?').bind(record.packageDigest).first<{status: string}>())?.status).toBe('PENDING');
    expect(await storage.package(record.packageDigest)).toBeNull();
    expect((await db.prepare('SELECT state FROM publisher_upload_operations WHERE operationId=?').bind(operation).first<{state: string}>())?.state).toBe('R2_PRESENT');
    const restarted = new DurablePublisherStorage(db, bucket);
    await db.prepare('DROP TRIGGER activation_fault').run();
    const results = await Promise.all([storage.upload(record, operation, digest), restarted.upload(record, operation, digest)]);
    expect(results[0]!.body).toBe(results[1]!.body);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM publisher_packages').first<{count: number}>())?.count).toBe(1);
    expect((await restarted.package(record.packageDigest))?.bytes).toEqual(record.bytes);
  });

  it('enforces publisher foreign keys before writing an operation or object', async () => {
    const {storage, db, bucket} = await fixture();
    const record = await packageRecord();
    await db.prepare('DELETE FROM publishers WHERE key_id=?').bind(record.publisherKeyId).run();
    await expect(db.prepare('INSERT INTO apps(id,publisher_id,app_namespace,created_at) VALUES(?,?,?,?)')
      .bind('unregistered', record.publisherKeyId, 'dev.example.unregistered', Date.now()).run()).rejects.toThrow();
    await expect(storage.upload(record, randomBytes(16).toString('base64url'), hash(record.bytes))).rejects.toMatchObject({code: 'PACKAGE_PUBLISHER_INVALID'});
    expect((await db.prepare('SELECT COUNT(*) AS count FROM publisher_upload_operations').first<{count: number}>())?.count).toBe(0);
    expect(await bucket.head(`packages/${record.packageDigest}.zip`)).toBeNull();
  });

  it('keeps missing or corrupted objects pending and never overwrites a conflicting object', async () => {
    const {storage, db, bucket} = await fixture();
    const record = await packageRecord(); const operation = randomBytes(16).toString('base64url');
    const stopped = {head: bucket.head.bind(bucket), get: bucket.get.bind(bucket), put: async () => { throw new Error('SIMULATED_BEFORE_PUT'); }} as unknown as R2Bucket;
    await expect(new DurablePublisherStorage(db, stopped).upload(record, operation, hash(record.bytes))).rejects.toThrow('SIMULATED_BEFORE_PUT');
    expect(await storage.reconcile()).toEqual({activated: 0, pending: 1});
    const objectKey = `packages/${record.packageDigest}.zip`;
    const corrupt = new Uint8Array(record.bytes); corrupt[60] ^= 1;
    await bucket.put(objectKey, corrupt, {customMetadata: {packageDigest: record.packageDigest, artifactDigest: record.artifactDigest,
      publisherKeyId: record.publisherKeyId, byteLength: String(record.byteLength)}});
    expect(await storage.reconcile()).toEqual({activated: 0, pending: 1});
    await expect(storage.upload(record, operation, hash(record.bytes))).rejects.toMatchObject({code: 'PACKAGE_OBJECT_MISMATCH'});
    expect(await storage.package(record.packageDigest)).toBeNull();
    expect(new Uint8Array(await (await bucket.get(objectKey))!.arrayBuffer())).toEqual(corrupt);
  });
  it('rolls back an interrupted version migration and preserves preceding publisher data', async () => {
    const {db, bucket} = await fixture();
    await db.prepare('DROP TABLE app_versions').run(); await db.prepare('DROP TABLE apps').run();
    await db.prepare('DELETE FROM publisher_schema_migrations WHERE version=2').run();
    const broken = {prepare: db.prepare.bind(db), batch: (statements: Parameters<D1Database['batch']>[0]) =>
      db.batch([...statements, db.prepare('INSERT INTO nonexistent_migration_fault VALUES(1)')])} as unknown as D1Database;
    await expect(new DurablePublisherStorage(broken, bucket).initialize()).rejects.toThrow();
    expect((await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('apps','app_versions')").first<{n: number}>())?.n).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM publishers').first<{n: number}>())?.n).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM publisher_schema_migrations').first<{n: number}>())?.n).toBe(1);
    await new DurablePublisherStorage(db, bucket).initialize();
    expect((await db.prepare('SELECT COUNT(*) AS n FROM publisher_schema_migrations').first<{n: number}>())?.n).toBe(2);
  });

  it('rejects copied verification metadata and altered bytes before any persistent reservation', async () => {
    const {storage, db, bucket} = await fixture(); const record = await packageRecord();
    const inspection = verifyUploadedPackage(record.bytes, record.packageDigest, record.publisherKeyId);
    expect(Object.isFrozen(inspection)).toBe(true);
    await expect(storage.upload(record, randomBytes(16).toString('base64url'), hash(record.bytes), {...inspection}))
      .rejects.toMatchObject({code: 'PACKAGE_OPERATION_INVALID'});
    const altered = new Uint8Array(record.bytes); altered[60] ^= 1;
    await expect(storage.upload({...record, bytes: altered}, randomBytes(16).toString('base64url'), hash(altered), inspection))
      .rejects.toMatchObject({code: 'PACKAGE_OPERATION_INVALID'});
    expect((await db.prepare('SELECT COUNT(*) AS n FROM app_versions').first<{n: number}>())?.n).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM publisher_upload_operations').first<{n: number}>())?.n).toBe(0);
    expect(await bucket.head(`packages/${record.packageDigest}.zip`)).toBeNull();
  });

  it('upgrades the preceding schema without losing active packages and rejects migration drift', async () => {
    const {db, bucket, restart} = await fixture();
    const record = await packageRecord();
    await db.prepare('DROP TABLE app_versions').run();
    await db.prepare('DROP TABLE apps').run();
    await db.prepare('DROP TABLE publisher_schema_migrations').run();
    await db.prepare('INSERT INTO publisher_packages VALUES(?,?,?,?,?)').bind(record.packageDigest, record.artifactDigest, record.publisherKeyId, record.byteLength, record.createdAt).run();
    await bucket.put(`packages/${record.packageDigest}.zip`, record.bytes, {customMetadata: {packageDigest: record.packageDigest,
      artifactDigest: record.artifactDigest, publisherKeyId: record.publisherKeyId, byteLength: String(record.byteLength)}});
    const upgraded = await restart();
    expect((await upgraded.package(record.packageDigest))?.bytes).toEqual(record.bytes);
    await upgraded.upload(record, randomBytes(16).toString('base64url'), hash(record.bytes));
    const upgradedDb = await miniflare!.getD1Database('DB');
    expect((await upgradedDb.prepare('SELECT status FROM app_versions WHERE package_digest=?').bind(record.packageDigest).first<{status: string}>())?.status).toBe('ACTIVE');
    await upgradedDb.prepare("UPDATE publisher_schema_migrations SET checksum='changed' WHERE version=1").run();
    await expect((await restart()).initialize()).rejects.toMatchObject({code: 'PUBLISHER_SCHEMA_INVALID'});
  });

  it('fails closed on missing legacy uploads but allows the exact verified bytes to restore them', async () => {
    const {storage, db, bucket} = await fixture();
    const record = await packageRecord(); const operation = randomBytes(16).toString('base64url');
    const stopped = {head: bucket.head.bind(bucket), get: bucket.get.bind(bucket), put: async () => {throw new Error('BEFORE_PUT');}} as unknown as R2Bucket;
    await expect(new DurablePublisherStorage(db, stopped).upload(record, operation, hash(record.bytes))).rejects.toThrow('BEFORE_PUT');
    await db.prepare('DELETE FROM app_versions').run();
    expect(await storage.reconcile()).toEqual({activated: 0, pending: 1});
    expect(await storage.package(record.packageDigest)).toBeNull();
    expect((await storage.upload(record, operation, hash(record.bytes))).created).toBe(true);
    expect((await storage.package(record.packageDigest))?.bytes).toEqual(record.bytes);
    await db.prepare("UPDATE app_versions SET manifest_json='{}'").run();
    await expect(storage.package(record.packageDigest)).rejects.toMatchObject({code: 'PACKAGE_VERSION_INVALID'});
    await expect(storage.upload(record, operation, hash(record.bytes))).rejects.toMatchObject({code: 'PACKAGE_VERSION_INVALID'});
  });

  it('reserves one signed publisher/app/version under races before any losing operation or R2 write', async () => {
    const {storage, db, bucket} = await fixture();
    const source = join(temporaryDirectory, 'source');
    await cp('examples/decision-board/package', source, {recursive: true});
    const native = async (store: string, ...args: string[]) => {
      try {const output = await promisify(execFile)(resolve('target/debug/smallframe-cli'), ['--json', '--test-store', join(temporaryDirectory, store), ...args], {maxBuffer: 32_768});
        return JSON.parse(output.stdout) as Record<string, string>;}
      catch {throw new Error('NATIVE_PACKAGE_FIXTURE_FAILED');}
    };
    const pack = async (store: string, name: string, version?: string) => {
      const file = join(source, 'smallframe.json');
      const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      manifest.name = name; if (version) manifest.version = version;
      await writeFile(file, JSON.stringify(manifest));
      const output = join(temporaryDirectory, `${store}-${name}.zip`);
      const packed = await native(store, 'pack', source, '--output', output);
      const bytes = new Uint8Array(await readFile(output));
      const inspected = verifyUploadedPackage(bytes, packed.packageDigest!, packed.publisherKeyId!);
      const publicManifest = JSON.parse(inspected.manifestJson) as {publisher: {publicKey: string}};
      await db.prepare('INSERT INTO publishers(id,public_key,key_id,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
        .bind(inspected.publisherKeyId, publicManifest.publisher.publicKey, inspected.publisherKeyId, Date.now()).run();
      return {...inspected, bytes, byteLength: bytes.length, createdAt: Date.now()};
    };
    await native('one', 'identity', 'init');
    const first = await pack('one', 'first'); const second = await pack('one', 'second');
    const results = await Promise.allSettled([first, second].map((record) => storage.upload(record, randomBytes(16).toString('base64url'), hash(record.bytes))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({code: 'PACKAGE_VERSION_CONFLICT'});
    const loser = results[0]!.status === 'rejected' ? first : second;
    expect(await bucket.head(`packages/${loser.packageDigest}.zip`)).toBeNull();
    expect((await db.prepare('SELECT COUNT(*) AS n FROM publisher_upload_operations').first<{n: number}>())?.n).toBe(1);
    // Simulate an active package from the preceding checkpoint with no version index.
    await db.prepare('DELETE FROM app_versions').run();
    await expect(storage.upload(loser, randomBytes(16).toString('base64url'), hash(loser.bytes)))
      .rejects.toMatchObject({code: 'PACKAGE_VERSION_CONFLICT'});
    expect(await bucket.head(`packages/${loser.packageDigest}.zip`)).toBeNull();
    const next = await pack('one', 'next', '0.2.0');
    const legacyDigest = hash(randomBytes(32)); const legacyOperation = randomBytes(16).toString('base64url');
    const legacyBody = JSON.stringify({ok: true, packageDigest: legacyDigest, artifactDigest: next.artifactDigest,
      publisherKeyId: next.publisherKeyId, byteLength: next.byteLength});
    await db.prepare(`INSERT INTO publisher_upload_operations(publisherKeyId,route,operationId,requestDigest,state,packageDigest,artifactDigest,byteLength,createdAt,responseBody)
      VALUES(?,'/v1/packages',?,?,'VALIDATED',?,?,?,?,?)`).bind(next.publisherKeyId, legacyOperation, hash(next.bytes),
        legacyDigest, next.artifactDigest, next.byteLength, Date.now(), legacyBody).run();
    await expect(storage.upload(next, randomBytes(16).toString('base64url'), hash(next.bytes)))
      .rejects.toMatchObject({code: 'PACKAGE_VERSION_MIGRATION_PENDING'});
    expect(await bucket.head(`packages/${next.packageDigest}.zip`)).toBeNull();
    await db.prepare('DELETE FROM publisher_upload_operations WHERE operationId=?').bind(legacyOperation).run();
    const competing = await pack('one', 'competing', '0.3.0');
    const sharedOperation = randomBytes(16).toString('base64url');
    let priorReadCount = 0; let releasePriorReads!: () => void;
    const priorReads = new Promise<void>((resolve) => {releasePriorReads = resolve;});
    const racingDb = {batch: db.batch.bind(db), prepare: (sql: string) => {
      const statement = db.prepare(sql);
      if (!sql.startsWith('SELECT * FROM publisher_upload_operations')) return statement;
      const wrap = (bound: ReturnType<D1Database['prepare']>): ReturnType<D1Database['prepare']> => new Proxy(bound, {get(target, property) {
        if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (property === 'first') return async () => {
          const row = await target.first();
          if (priorReadCount < 2) {expect(row).toBeNull(); priorReadCount++; if (priorReadCount === 2) releasePriorReads(); await priorReads;}
          return row;
        };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      }});
      return wrap(statement);
    }} as unknown as D1Database;
    const racingStorage = new DurablePublisherStorage(racingDb, bucket);
    const raced = await Promise.allSettled([next, competing].map((record) => racingStorage.upload(record, sharedOperation, hash(record.bytes))));
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((raced.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({code: 'IDEMPOTENCY_MISMATCH'});
    const operationLoser = raced[0]!.status === 'rejected' ? next : competing;
    expect(await bucket.head(`packages/${operationLoser.packageDigest}.zip`)).toBeNull();
    expect(await db.prepare('SELECT package_digest FROM app_versions WHERE package_digest=?').bind(operationLoser.packageDigest).first()).toBeNull();
    expect((await db.prepare('SELECT COUNT(*) AS n FROM publisher_upload_operations').first<{n: number}>())?.n).toBe(2);
    await native('two', 'identity', 'init');
    const other = await pack('two', 'other', '0.1.0');
    await storage.upload(other, randomBytes(16).toString('base64url'), hash(other.bytes));
    expect((await db.prepare('SELECT COUNT(*) AS n FROM apps').first<{n: number}>())?.n).toBe(2);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM app_versions WHERE status='ACTIVE'").first<{n: number}>())?.n).toBe(3);
  });

});
