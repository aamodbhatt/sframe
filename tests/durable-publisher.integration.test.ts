import {createHash, randomBytes} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {Miniflare} from 'miniflare';
import type {D1Database, R2Bucket} from '@cloudflare/workers-types';
import {DurablePublisherStorage} from '../apps/api/src/durable-publisher-storage.js';
import {createSignedEnrollment} from '../packages/protocol/src/index.js';
import cases from '../packages/protocol/vectors/package-cases-v1.json';

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
    const broken = {prepare: db.prepare.bind(db), batch: (statements: Parameters<D1Database['batch']>[0]) =>
      db.batch(statements.length === 3 ? [...statements, db.prepare('INSERT INTO nonexistent_fault_table VALUES(1)')] : statements)} as unknown as D1Database;
    await expect(new DurablePublisherStorage(broken, bucket).enroll(pending.record, pending.digest)).rejects.toMatchObject({code: 'ENROLLMENT_CONFLICT'});
    expect(await storage.publisher(pending.record.tokenHash)).toBeNull();
    expect((await db.prepare('SELECT usedAt FROM publisher_invites WHERE codeHash=?').bind(pending.record.inviteCodeHash).first<{usedAt: number | null}>())?.usedAt).toBeNull();
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
    const broken = {prepare: db.prepare.bind(db), batch: (statements: Parameters<D1Database['batch']>[0]) =>
      db.batch(statements.length === 2 ? [...statements, db.prepare('INSERT INTO nonexistent_activation_fault VALUES(1)')] : statements)} as unknown as D1Database;
    await expect(new DurablePublisherStorage(broken, bucket).upload(record, operation, digest)).rejects.toThrow();
    expect(await storage.package(record.packageDigest)).toBeNull();
    expect((await db.prepare('SELECT state FROM publisher_upload_operations WHERE operationId=?').bind(operation).first<{state: string}>())?.state).toBe('R2_PRESENT');
    const restarted = new DurablePublisherStorage(db, bucket);
    const results = await Promise.all([storage.upload(record, operation, digest), restarted.upload(record, operation, digest)]);
    expect(results[0]!.body).toBe(results[1]!.body);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM publisher_packages').first<{count: number}>())?.count).toBe(1);
    expect((await restarted.package(record.packageDigest))?.bytes).toEqual(record.bytes);
  });

  it('enforces publisher foreign keys before writing an operation or object', async () => {
    const {storage, db, bucket} = await fixture();
    const record = await packageRecord(); record.publisherKeyId = `sha256:${hash(randomBytes(32))}`;
    await expect(storage.upload(record, randomBytes(16).toString('base64url'), hash(record.bytes))).rejects.toThrow();
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
});
