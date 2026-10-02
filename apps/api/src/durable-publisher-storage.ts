import type {D1Database, R2Bucket, R2Object} from '@cloudflare/workers-types';
import {decodeBase64Url, encodeBase64Url, type PublisherEnrollmentRecord} from '../../../packages/protocol/src/index.js';
import {fail} from './publisher-storage-errors.js';
import {migratePublisherSchema} from './publisher-schema-migrations.js';
import {PublisherAuthority} from './publisher-authority.js';
import {PublisherVersionIndex} from './publisher-version-index.js';
import {verifyUploadedPackage, isVerifiedInspection, type PackageManifestMetadata} from './package-verifier.js';
import {DurableRoomStorage} from './durable-room-storage.js';
import type {StoredInvite, StoredPackageRecord, StoredPublisher} from './publish-api.js';


type EnrollmentRow = StoredPublisher & {operationId: string; requestDigest: string; responseBody: string; revokedAt: number | null};
type UploadRow = Omit<StoredPackageRecord, 'bytes'> & {operationId: string; requestDigest: string; state: string; responseBody: string};
export {PublisherStorageError} from './publisher-storage-errors.js';
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

const validateInspectedBytes = async (record: StoredPackageRecord, inspected: ReturnType<typeof verifyUploadedPackage>): Promise<void> => {
  if (!isVerifiedInspection(inspected) || inspected.packageDigest !== record.packageDigest
    || inspected.artifactDigest !== record.artifactDigest || inspected.publisherKeyId !== record.publisherKeyId
    || record.bytes.byteLength !== record.byteLength
    || encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', record.bytes))) !== record.artifactDigest) fail(409, 'PACKAGE_OPERATION_INVALID');
};

export class DurablePublisherStorage {
  private ready: Promise<unknown> | undefined;
  readonly rooms: DurableRoomStorage;
  private readonly authority: PublisherAuthority;
  private readonly versions: PublisherVersionIndex;
  constructor(readonly db: D1Database, readonly bucket: R2Bucket, readonly now = Date.now) {
    this.authority = new PublisherAuthority(db, now);
    this.versions = new PublisherVersionIndex(db);
    this.rooms = new DurableRoomStorage(db, () => this.initialize(), now);
  }
  async initialize(): Promise<void> {
    this.ready ??= migratePublisherSchema(this.db);
    await this.ready;
  }
  async createInvite(record: StoredInvite): Promise<boolean> {
    await this.initialize();
    return this.authority.createInvite(record);
  }
  async publisher(tokenHash: string): Promise<StoredPublisher | null> {
    await this.initialize();
    return this.authority.publisher(tokenHash);
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
    await this.authority.assertEnrollment(saved);
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
      await this.db.batch(this.authority.enrollmentStatements(record, requestDigest, responseBody, now));
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
    await this.authority.revoke(tokenHash);
  }
  private operation(publisher: string, operationId: string): Promise<UploadRow | null> {
    return this.db.prepare("SELECT * FROM publisher_upload_operations WHERE publisherKeyId=? AND route='/v1/packages' AND operationId=?").bind(publisher, operationId).first<UploadRow>();
  }
  async upload(record: StoredPackageRecord, operationId: string, requestDigest: string, manifest?: PackageManifestMetadata & {packageDigest: string; artifactDigest: string; publisherKeyId: string}): Promise<{body: string; created: boolean}> {
    record = {...record, bytes: new Uint8Array(record.bytes)};
    await this.initialize();
    const body = uploadResponse(record);
    const prior = await this.operation(record.publisherKeyId, operationId);
    if (prior && prior.requestDigest !== requestDigest) fail(409, 'IDEMPOTENCY_MISMATCH');
    if (prior) validateOperation(prior);
    const inspected = manifest ?? verifyUploadedPackage(record.bytes, record.packageDigest, record.publisherKeyId);
    await validateInspectedBytes(record, inspected);
    validateOperation({...record, operationId, requestDigest, state: 'VALIDATED', responseBody: body});
    await this.backfillVersions(record);
    // A changed concurrent operation hits the state CHECK and rolls back the
    // entire reservation batch. Exact replay preserves its current saga state.
    try {
      await this.versions.reserve(record, inspected, [this.db.prepare(`INSERT INTO publisher_upload_operations(publisherKeyId,route,operationId,requestDigest,state,packageDigest,artifactDigest,byteLength,createdAt,responseBody)
      VALUES(?,'/v1/packages',?,?,'VALIDATED',?,?,?,?,?)
      ON CONFLICT(publisherKeyId,route,operationId) DO UPDATE SET state=CASE
        WHEN publisher_upload_operations.requestDigest=excluded.requestDigest
          AND publisher_upload_operations.packageDigest=excluded.packageDigest
          AND publisher_upload_operations.artifactDigest=excluded.artifactDigest
          AND publisher_upload_operations.byteLength=excluded.byteLength
          AND publisher_upload_operations.responseBody=excluded.responseBody
        THEN publisher_upload_operations.state ELSE 'IDEMPOTENCY_MISMATCH' END`)
      .bind(record.publisherKeyId, operationId, requestDigest, record.packageDigest, record.artifactDigest, record.byteLength, this.now(), body)]);
    } catch (error) {
      const raced = await this.operation(record.publisherKeyId, operationId);
      if (raced && raced.requestDigest !== requestDigest) fail(409, 'IDEMPOTENCY_MISMATCH');
      throw error;
    }
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
    await this.versions.assertReserved(operation);
    await this.db.batch([
      this.versions.activateStatement(operation),
      this.db.prepare(`INSERT INTO publisher_packages(packageDigest,artifactDigest,publisherKeyId,byteLength,createdAt) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(operation.packageDigest, operation.artifactDigest, operation.publisherKeyId, operation.byteLength, operation.createdAt),
      this.db.prepare(`UPDATE publisher_upload_operations SET state='D1_ACTIVE',completedAt=COALESCE(completedAt,?) WHERE publisherKeyId=? AND route='/v1/packages' AND operationId=?
        AND EXISTS(SELECT 1 FROM publisher_packages WHERE packageDigest=? AND artifactDigest=? AND publisherKeyId=? AND byteLength=?)
        AND EXISTS(SELECT 1 FROM app_versions WHERE package_digest=? AND status='ACTIVE')`)
        .bind(this.now(), operation.publisherKeyId, operation.operationId, operation.packageDigest, operation.artifactDigest, operation.publisherKeyId, operation.byteLength, operation.packageDigest),
    ]);
    if ((await this.operation(operation.publisherKeyId, operation.operationId))?.state !== 'D1_ACTIVE') fail(409, 'PACKAGE_UPLOAD_CONFLICT');
  }
  async package(digest: string): Promise<StoredPackageRecord | null> {
    await this.initialize();
    const record = await this.db.prepare('SELECT * FROM publisher_packages WHERE packageDigest=?').bind(digest).first<Omit<StoredPackageRecord, 'bytes'>>();
    if (!record) return null;
    if (!validMetadata(record)) fail(409, 'STORED_PACKAGE_INVALID');
    await this.versions.assertIndexed(record);
    const object = await this.bucket.get(key(digest));
    if (!matches(object, record) || !object || object.size > 8_192) fail(409, 'STORED_PACKAGE_INVALID');
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== record.byteLength
      || encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) !== record.artifactDigest) fail(409, 'STORED_PACKAGE_INVALID');
    return {...record, bytes};
  }
  private async backfillVersions(supplied?: StoredPackageRecord, publisher = supplied?.publisherKeyId): Promise<void> {
    const rows = await this.db.prepare(`SELECT packageDigest,artifactDigest,publisherKeyId,byteLength,createdAt FROM publisher_packages
      WHERE (? IS NULL OR publisherKeyId=?) AND packageDigest NOT IN (SELECT package_digest FROM app_versions)
      UNION SELECT packageDigest,artifactDigest,publisherKeyId,byteLength,createdAt FROM publisher_upload_operations
      WHERE (? IS NULL OR publisherKeyId=?) AND packageDigest NOT IN (SELECT package_digest FROM app_versions) LIMIT 101`)
      .bind(publisher ?? null, publisher ?? null, publisher ?? null, publisher ?? null)
      .all<Omit<StoredPackageRecord, 'bytes'>>();
    for (const row of rows.results.slice(0, 100)) {
      if (!validMetadata(row)) fail(409, 'STORED_PACKAGE_INVALID');
      const candidate = supplied?.packageDigest === row.packageDigest ? supplied : await this.readLegacyObject(row);
      if (candidate.artifactDigest !== row.artifactDigest || candidate.byteLength !== row.byteLength) fail(409, 'PACKAGE_OPERATION_INVALID');
      const inspected = verifyUploadedPackage(candidate.bytes, row.packageDigest, row.publisherKeyId);
      if (inspected.artifactDigest !== row.artifactDigest) fail(409, 'STORED_PACKAGE_INVALID');
      const active = await this.db.prepare('SELECT packageDigest FROM publisher_packages WHERE packageDigest=?').bind(row.packageDigest).first();
      await this.versions.reserve(row, inspected, [], active ? 'ACTIVE' : 'PENDING');
    }
    if (rows.results.length > 100) fail(503, 'PACKAGE_VERSION_MIGRATION_PENDING');
  }
  private async readLegacyObject(record: Omit<StoredPackageRecord, 'bytes'>): Promise<StoredPackageRecord> {
    const object = await this.bucket.get(key(record.packageDigest));
    if (!object || !matches(object, record) || object.size > 8_192) fail(409, 'PACKAGE_VERSION_MIGRATION_PENDING');
    return {...record, bytes: new Uint8Array(await object.arrayBuffer())};
  }
  async reconcile(): Promise<{activated: number; pending: number}> {
    await this.initialize();
    const operations = await this.db.prepare("SELECT * FROM publisher_upload_operations WHERE state!='D1_ACTIVE' ORDER BY checkedAt,createdAt,operationId LIMIT 100").all<UploadRow>();
    const migrations = new Map<string, Promise<void>>();
    let activated = 0; let pending = 0;
    for (const operation of operations.results) {
      try {
        if (!await this.versions.hasVersion(operation.packageDigest)) {
          if (!migrations.has(operation.publisherKeyId)) migrations.set(operation.publisherKeyId, this.backfillVersions(undefined, operation.publisherKeyId));
          await migrations.get(operation.publisherKeyId);
        }
        await this.activate(operation); activated++;
      } catch { pending++; }
      await this.db.prepare("UPDATE publisher_upload_operations SET checkedAt=? WHERE publisherKeyId=? AND route='/v1/packages' AND operationId=?")
        .bind(this.now(), operation.publisherKeyId, operation.operationId).run();
    }
    return {activated, pending};
  }
  async cleanup(): Promise<void> {
    await this.initialize();
    // Active enrollment results survive beyond 24h until revocation+30 days.
    await this.db.batch([
      this.authority.cleanupStatement(this.now() - 30 * 86_400_000),
      this.db.prepare('DELETE FROM publisher_enrollments WHERE revokedAt IS NOT NULL AND revokedAt<?').bind(this.now() - 30 * 86_400_000),
      this.db.prepare("DELETE FROM publisher_upload_operations WHERE state='D1_ACTIVE' AND completedAt<?").bind(this.now() - 86_400_000),
    ]);
    await this.rooms.cleanup();
  }
}
