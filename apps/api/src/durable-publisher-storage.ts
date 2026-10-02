import type {D1Database, R2Bucket, R2Object} from '@cloudflare/workers-types';
import {decodeBase64Url, encodeBase64Url, type PublisherEnrollmentRecord} from '../../../packages/protocol/src/index.js';
import type {StoredInvite, StoredPackageRecord, StoredPublisher} from './publish-api.js';

// Local schema only. Production routes remain closed; no remote migration runs.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS publishers (id TEXT PRIMARY KEY, public_key TEXT NOT NULL, key_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ACTIVE', created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS publisher_invites (codeHash TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, usedAt INTEGER, usedByPublisherKeyId TEXT REFERENCES publishers(key_id))`,
  `CREATE TABLE IF NOT EXISTS publisher_enrollments (publisherKeyId TEXT PRIMARY KEY REFERENCES publishers(key_id), publisherPublicKey TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE, enrolledAt INTEGER NOT NULL, revokedAt INTEGER, inviteCodeHash TEXT NOT NULL UNIQUE REFERENCES publisher_invites(codeHash), operationId TEXT NOT NULL, requestDigest TEXT NOT NULL, responseBody TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS publisher_packages (packageDigest TEXT PRIMARY KEY, artifactDigest TEXT NOT NULL, publisherKeyId TEXT NOT NULL REFERENCES publishers(key_id), byteLength INTEGER NOT NULL, createdAt INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS publisher_upload_operations (publisherKeyId TEXT NOT NULL REFERENCES publishers(key_id), route TEXT NOT NULL CHECK(route='/v1/packages'), operationId TEXT NOT NULL, requestDigest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('VALIDATED','R2_PRESENT','D1_ACTIVE')), packageDigest TEXT NOT NULL, artifactDigest TEXT NOT NULL, byteLength INTEGER NOT NULL, createdAt INTEGER NOT NULL, checkedAt INTEGER NOT NULL DEFAULT 0, completedAt INTEGER, responseBody TEXT NOT NULL, PRIMARY KEY(publisherKeyId,route,operationId))`,
  `CREATE INDEX IF NOT EXISTS publisher_upload_reconcile ON publisher_upload_operations(state,checkedAt,createdAt)`,
];

type EnrollmentRow = StoredPublisher & {operationId: string; requestDigest: string; responseBody: string; revokedAt: number | null};
type UploadRow = Omit<StoredPackageRecord, 'bytes'> & {operationId: string; requestDigest: string; state: string; responseBody: string};
export class PublisherStorageError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function fail(status: number, code: string): never { throw new PublisherStorageError(status, code); }
const key = (digest: string): string => `packages/${digest}.zip`;
const metadata = (record: Omit<StoredPackageRecord, 'bytes'>): Record<string, string> => ({
  packageDigest: record.packageDigest, artifactDigest: record.artifactDigest,
  publisherKeyId: record.publisherKeyId, byteLength: String(record.byteLength),
});
const matches = (object: R2Object | null, record: Omit<StoredPackageRecord, 'bytes'>): boolean =>
  object !== null && object.size === record.byteLength
  && Object.entries(metadata(record)).every(([field, value]) => object.customMetadata?.[field] === value);

const canonicalFixed = (value: string, length: number): boolean => {
  try { const bytes = decodeBase64Url(value); return bytes.byteLength === length && encodeBase64Url(bytes) === value; } catch { return false; }
};
const validMetadata = (record: Omit<StoredPackageRecord, 'bytes'>): boolean =>
  canonicalFixed(record.packageDigest, 32) && canonicalFixed(record.artifactDigest, 32)
  && record.publisherKeyId.startsWith('sha256:') && canonicalFixed(record.publisherKeyId.slice(7), 32)
  && Number.isSafeInteger(record.byteLength) && record.byteLength >= 100 && record.byteLength <= 8_192
  && Number.isSafeInteger(record.createdAt) && record.createdAt >= 0;
const uploadResponse = (record: Omit<StoredPackageRecord, 'bytes'>): string =>
  JSON.stringify({ok: true, packageDigest: record.packageDigest, artifactDigest: record.artifactDigest,
    publisherKeyId: record.publisherKeyId, byteLength: record.byteLength});
const validateOperation = (operation: UploadRow): void => {
  if (!validMetadata(operation) || !canonicalFixed(operation.operationId, 16) || !canonicalFixed(operation.requestDigest, 32)
    || !['VALIDATED', 'R2_PRESENT', 'D1_ACTIVE'].includes(operation.state)
    || operation.responseBody !== uploadResponse(operation)) fail(409, 'PACKAGE_OPERATION_INVALID');
};

export class DurablePublisherStorage {
  private ready: Promise<unknown> | undefined;
  constructor(readonly db: D1Database, readonly bucket: R2Bucket, readonly now = Date.now) {}
  async initialize(): Promise<void> {
    this.ready ??= this.db.batch(SCHEMA.map((sql) => this.db.prepare(sql)));
    await this.ready;
  }
  async createInvite(record: StoredInvite): Promise<boolean> {
    await this.initialize();
    const result = await this.db.prepare('INSERT INTO publisher_invites(codeHash,createdAt,expiresAt) VALUES(?,?,?) ON CONFLICT(codeHash) DO NOTHING')
      .bind(record.codeHash, record.createdAt, record.expiresAt).run();
    return result.meta.changes === 1;
  }
  async publisher(tokenHash: string): Promise<StoredPublisher | null> {
    await this.initialize();
    return this.db.prepare('SELECT publisherKeyId,publisherPublicKey,tokenHash,enrolledAt FROM publisher_enrollments WHERE tokenHash=? AND revokedAt IS NULL').bind(tokenHash).first<StoredPublisher>();
  }
  private async enrollment(publisherKeyId: string, operationId: string): Promise<EnrollmentRow | null> {
    return this.db.prepare('SELECT * FROM publisher_enrollments WHERE publisherKeyId=? AND operationId=?').bind(publisherKeyId, operationId).first<EnrollmentRow>();
  }
  async replayEnrollment(record: PublisherEnrollmentRecord, digest: string): Promise<string | null> {
    await this.initialize();
    const saved = await this.enrollment(record.publisherKeyId, record.operationId);
    if (!saved) return null;
    if (saved.requestDigest !== digest) fail(409, 'IDEMPOTENCY_MISMATCH');
    if (saved.publisherPublicKey !== record.publisherPublicKey || saved.tokenHash !== record.tokenHash
      || !Number.isSafeInteger(saved.enrolledAt)
      || saved.responseBody !== JSON.stringify({ok: true, publisherKeyId: record.publisherKeyId, enrolledAt: saved.enrolledAt})) fail(409, 'ENROLLMENT_RECORD_INVALID');
    if (saved.revokedAt !== null) fail(403, 'PUBLISHER_REVOKED');
    return saved.responseBody;
  }
  async enroll(record: PublisherEnrollmentRecord, requestDigest: string): Promise<{body: string; created: boolean}> {
    const replay = await this.replayEnrollment(record, requestDigest);
    if (replay) return {body: replay, created: false};
    const now = this.now();
    const responseBody = JSON.stringify({ok: true, publisherKeyId: record.publisherKeyId, enrolledAt: now});
    // One D1 transaction consumes the invite and activates the token/result.
    // Uniqueness failures roll back every statement; the conditional insert
    // prevents concurrent different publishers from consuming one invite.
    try {
      await this.db.batch([
        this.db.prepare(`INSERT INTO publishers(id,public_key,key_id,created_at)
          SELECT ?,?,?,? FROM publisher_invites WHERE codeHash=? AND usedAt IS NULL AND expiresAt>=? ON CONFLICT(key_id) DO NOTHING`)
          .bind(record.publisherKeyId, record.publisherPublicKey, record.publisherKeyId, now, record.inviteCodeHash, now),
        this.db.prepare(`INSERT INTO publisher_enrollments(publisherKeyId,publisherPublicKey,tokenHash,enrolledAt,inviteCodeHash,operationId,requestDigest,responseBody)
          SELECT ?,?,?,?,?,?,?,? FROM publisher_invites WHERE codeHash=? AND usedAt IS NULL AND expiresAt>=?`)
          .bind(record.publisherKeyId, record.publisherPublicKey, record.tokenHash, now, record.inviteCodeHash, record.operationId, requestDigest, responseBody, record.inviteCodeHash, now),
        this.db.prepare(`UPDATE publisher_invites SET usedAt=?,usedByPublisherKeyId=? WHERE codeHash=? AND usedAt IS NULL
          AND EXISTS(SELECT 1 FROM publisher_enrollments WHERE publisherKeyId=? AND operationId=? AND requestDigest=?)`)
          .bind(now, record.publisherKeyId, record.inviteCodeHash, record.publisherKeyId, record.operationId, requestDigest),
      ]);
    } catch {
      const raced = await this.replayEnrollment(record, requestDigest);
      if (raced) return {body: raced, created: false};
      fail(409, 'ENROLLMENT_CONFLICT');
    }
    const committed = await this.replayEnrollment(record, requestDigest);
    if (!committed) fail(403, 'INVITE_UNAVAILABLE');
    return {body: committed, created: true};
  }
  async revoke(tokenHash: string): Promise<void> {
    await this.initialize();
    await this.db.prepare('UPDATE publisher_enrollments SET revokedAt=? WHERE tokenHash=? AND revokedAt IS NULL').bind(this.now(), tokenHash).run();
  }
  private operation(publisher: string, operationId: string): Promise<UploadRow | null> {
    return this.db.prepare("SELECT * FROM publisher_upload_operations WHERE publisherKeyId=? AND route='/v1/packages' AND operationId=?").bind(publisher, operationId).first<UploadRow>();
  }
  async upload(record: StoredPackageRecord, operationId: string, requestDigest: string): Promise<{body: string; created: boolean}> {
    record = {...record, bytes: new Uint8Array(record.bytes)};
    await this.initialize();
    const body = uploadResponse(record);
    await this.db.prepare(`INSERT INTO publisher_upload_operations(publisherKeyId,route,operationId,requestDigest,state,packageDigest,artifactDigest,byteLength,createdAt,responseBody)
      VALUES(?,'/v1/packages',?,?,'VALIDATED',?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .bind(record.publisherKeyId, operationId, requestDigest, record.packageDigest, record.artifactDigest, record.byteLength, this.now(), body).run();
    const operation = await this.operation(record.publisherKeyId, operationId);
    if (!operation || operation.requestDigest !== requestDigest) fail(409, 'IDEMPOTENCY_MISMATCH');
    if (operation.packageDigest !== record.packageDigest || operation.artifactDigest !== record.artifactDigest
      || operation.byteLength !== record.byteLength || operation.responseBody !== body) fail(409, 'PACKAGE_OPERATION_INVALID');
    const alreadyActive = operation.state === 'D1_ACTIVE';
    if (!matches(await this.bucket.head(key(record.packageDigest)), record)) {
      await this.bucket.put(key(record.packageDigest), record.bytes, {onlyIf: {etagDoesNotMatch: '*'}, customMetadata: metadata(record), httpMetadata: {contentType: 'application/vnd.smallframe.package'}});
    }
    await this.activate(operation);
    return {body: operation.responseBody, created: !alreadyActive};
  }
  private async confirmObject(operation: UploadRow): Promise<void> {
    if (!matches(await this.bucket.head(key(operation.packageDigest)), operation)) fail(409, 'PACKAGE_OBJECT_MISMATCH');
    const object = await this.bucket.get(key(operation.packageDigest));
    if (!object || !matches(object, operation) || object.size > 8_192) fail(409, 'PACKAGE_OBJECT_MISMATCH');
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== operation.byteLength
      || encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) !== operation.artifactDigest) fail(409, 'PACKAGE_OBJECT_MISMATCH');
  }
  private async activate(operation: UploadRow): Promise<void> {
    validateOperation(operation);
    await this.confirmObject(operation);
    await this.db.prepare("UPDATE publisher_upload_operations SET state='R2_PRESENT' WHERE publisherKeyId=? AND route='/v1/packages' AND operationId=? AND state='VALIDATED'")
      .bind(operation.publisherKeyId, operation.operationId).run();
    await this.db.batch([
      this.db.prepare(`INSERT INTO publisher_packages(packageDigest,artifactDigest,publisherKeyId,byteLength,createdAt) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(operation.packageDigest, operation.artifactDigest, operation.publisherKeyId, operation.byteLength, operation.createdAt),
      this.db.prepare(`UPDATE publisher_upload_operations SET state='D1_ACTIVE',completedAt=COALESCE(completedAt,?) WHERE publisherKeyId=? AND route='/v1/packages' AND operationId=?
        AND EXISTS(SELECT 1 FROM publisher_packages WHERE packageDigest=? AND artifactDigest=? AND publisherKeyId=? AND byteLength=?)`)
        .bind(this.now(), operation.publisherKeyId, operation.operationId, operation.packageDigest, operation.artifactDigest, operation.publisherKeyId, operation.byteLength),
    ]);
    if ((await this.operation(operation.publisherKeyId, operation.operationId))?.state !== 'D1_ACTIVE') fail(409, 'PACKAGE_UPLOAD_CONFLICT');
  }
  async package(digest: string): Promise<StoredPackageRecord | null> {
    await this.initialize();
    const record = await this.db.prepare('SELECT * FROM publisher_packages WHERE packageDigest=?').bind(digest).first<Omit<StoredPackageRecord, 'bytes'>>();
    if (!record) return null;
    if (!validMetadata(record)) fail(409, 'STORED_PACKAGE_INVALID');
    const object = await this.bucket.get(key(digest));
    if (!matches(object, record) || !object || object.size > 8_192) fail(409, 'STORED_PACKAGE_INVALID');
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== record.byteLength
      || encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) !== record.artifactDigest) fail(409, 'STORED_PACKAGE_INVALID');
    return {...record, bytes};
  }
  async reconcile(): Promise<{activated: number; pending: number}> {
    await this.initialize();
    const operations = await this.db.prepare("SELECT * FROM publisher_upload_operations WHERE state!='D1_ACTIVE' ORDER BY checkedAt,createdAt,operationId LIMIT 100").all<UploadRow>();
    let activated = 0; let pending = 0;
    for (const operation of operations.results) {
      try { await this.activate(operation); activated++; } catch { pending++; }
      await this.db.prepare("UPDATE publisher_upload_operations SET checkedAt=? WHERE publisherKeyId=? AND route='/v1/packages' AND operationId=?")
        .bind(this.now(), operation.publisherKeyId, operation.operationId).run();
    }
    return {activated, pending};
  }
  async cleanup(): Promise<void> {
    await this.initialize();
    // Active enrollment results survive beyond 24h until revocation+30 days.
    await this.db.batch([
      this.db.prepare('DELETE FROM publisher_enrollments WHERE revokedAt IS NOT NULL AND revokedAt<?').bind(this.now() - 30 * 86_400_000),
      this.db.prepare("DELETE FROM publisher_upload_operations WHERE state='D1_ACTIVE' AND completedAt<?").bind(this.now() - 86_400_000),
    ]);
  }
}
