import type {D1Database, D1PreparedStatement} from '@cloudflare/workers-types';
import type {PublisherEnrollmentRecord} from '../../../packages/protocol/src/index.js';
import type {StoredInvite, StoredPublisher} from './publish-api.js';
import {fail} from './publisher-storage-errors.js';

type Enrollment = StoredPublisher & {revokedAt: number | null};
const ELIGIBLE_INVITE = `FROM invite_codes i JOIN publisher_invites legacy ON legacy.codeHash=i.code_hash
  WHERE i.code_hash=? AND i.used_at IS NULL AND i.expires_at>=?
  AND legacy.usedAt IS NULL AND legacy.expiresAt=i.expires_at AND legacy.createdAt=i.created_at`;

const AUTHENTICATED_PUBLISHER = `SELECT e.publisherKeyId,e.publisherPublicKey,e.tokenHash,e.enrolledAt,p.id AS publisherId
  FROM api_tokens t JOIN publishers p ON p.id=t.publisher_id JOIN publisher_enrollments e ON e.tokenHash=t.token_hash
  WHERE t.token_hash=? AND t.revoked_at IS NULL AND e.revokedAt IS NULL AND p.status='ACTIVE'
  AND e.publisherKeyId=p.key_id AND e.publisherPublicKey=p.public_key AND e.enrolledAt=t.created_at`;

export class PublisherAuthority {
  constructor(private readonly db: D1Database, private readonly now: () => number) {}
  async createInvite(record: StoredInvite): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare('INSERT INTO invite_codes(code_hash,created_at,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING')
        .bind(record.codeHash, record.createdAt, record.expiresAt),
      this.db.prepare('INSERT INTO publisher_invites(codeHash,createdAt,expiresAt) VALUES(?,?,?) ON CONFLICT DO NOTHING')
        .bind(record.codeHash, record.createdAt, record.expiresAt),
    ]);
    return results.every((result) => result.meta.changes === 1);
  }
  async publisher(tokenHash: string): Promise<StoredPublisher | null> {
    const bucket = Math.floor(this.now() / 86_400_000) * 86_400_000;
    // Authorization and coarse usage share one D1 snapshot. Never record failed
    // authority as successful use, or return a pre-revocation read after a gap.
    const results = await this.db.batch<StoredPublisher>([
      this.db.prepare(`UPDATE api_tokens SET last_used_bucket=? WHERE token_hash=? AND revoked_at IS NULL
        AND (last_used_bucket IS NULL OR last_used_bucket<?) AND EXISTS(${AUTHENTICATED_PUBLISHER})`)
        .bind(bucket, tokenHash, bucket, tokenHash),
      this.db.prepare(AUTHENTICATED_PUBLISHER).bind(tokenHash),
    ]);
    return results[1]!.results[0] ?? null;
  }

  async assertEnrollment(saved: Enrollment): Promise<void> {
    const authority = await this.db.prepare(`SELECT t.created_at,t.revoked_at,p.key_id,p.public_key,p.status
      FROM api_tokens t JOIN publishers p ON p.id=t.publisher_id WHERE t.token_hash=?`).bind(saved.tokenHash)
      .first<{created_at: number; revoked_at: number | null; key_id: string; public_key: string; status: string}>();
    if (!authority || authority.key_id !== saved.publisherKeyId || authority.public_key !== saved.publisherPublicKey
      || authority.created_at !== saved.enrolledAt) fail(409, 'ENROLLMENT_RECORD_INVALID');
    if (saved.revokedAt !== null || authority.revoked_at !== null || authority.status !== 'ACTIVE') fail(403, 'PUBLISHER_REVOKED');
  }
  enrollmentStatements(record: PublisherEnrollmentRecord, requestDigest: string, responseBody: string, now: number): D1PreparedStatement[] {
    return [
      this.db.prepare(`INSERT INTO publishers(id,public_key,key_id,created_at) SELECT ?,?,?,? ${ELIGIBLE_INVITE} ON CONFLICT(key_id) DO NOTHING`)
        .bind(record.publisherKeyId, record.publisherPublicKey, record.publisherKeyId, now, record.inviteCodeHash, now),
      this.db.prepare(`INSERT INTO publisher_enrollments(publisherKeyId,publisherPublicKey,tokenHash,enrolledAt,inviteCodeHash,operationId,requestDigest,responseBody)
        SELECT ?,?,?,?,?,?,?,? ${ELIGIBLE_INVITE} AND EXISTS(SELECT 1 FROM publishers WHERE key_id=? AND public_key=? AND status='ACTIVE')`)
        .bind(record.publisherKeyId, record.publisherPublicKey, record.tokenHash, now, record.inviteCodeHash, record.operationId,
          requestDigest, responseBody, record.inviteCodeHash, now, record.publisherKeyId, record.publisherPublicKey),
      this.db.prepare(`INSERT INTO api_tokens(token_hash,publisher_id,created_at)
        SELECT e.tokenHash,p.id,e.enrolledAt FROM publisher_enrollments e JOIN publishers p ON p.key_id=e.publisherKeyId
        WHERE e.publisherKeyId=? AND e.operationId=? AND e.requestDigest=?`)
        .bind(record.publisherKeyId, record.operationId, requestDigest),
      this.db.prepare(`UPDATE invite_codes SET used_at=?,publisher_id=(SELECT id FROM publishers WHERE key_id=?)
        WHERE code_hash=? AND used_at IS NULL AND EXISTS(SELECT 1 FROM publisher_enrollments e JOIN api_tokens t ON t.token_hash=e.tokenHash
          WHERE e.publisherKeyId=? AND e.operationId=? AND e.requestDigest=?)`)
        .bind(now, record.publisherKeyId, record.inviteCodeHash, record.publisherKeyId, record.operationId, requestDigest),
      this.db.prepare(`UPDATE publisher_invites SET usedAt=?,usedByPublisherKeyId=? WHERE codeHash=? AND usedAt IS NULL
        AND EXISTS(SELECT 1 FROM invite_codes WHERE code_hash=? AND used_at=? AND publisher_id=(SELECT id FROM publishers WHERE key_id=?))`)
        .bind(now, record.publisherKeyId, record.inviteCodeHash, record.inviteCodeHash, now, record.publisherKeyId),
    ];
  }
  async revoke(tokenHash: string): Promise<void> {
    const now = this.now();
    await this.db.batch([
      this.db.prepare('UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE token_hash=?').bind(now, tokenHash),
      this.db.prepare('UPDATE publisher_enrollments SET revokedAt=COALESCE(revokedAt,?) WHERE tokenHash=?').bind(now, tokenHash),
    ]);
  }
  cleanupStatement(before: number): D1PreparedStatement {
    return this.db.prepare('DELETE FROM api_tokens WHERE revoked_at IS NOT NULL AND revoked_at<?').bind(before);
  }
}
