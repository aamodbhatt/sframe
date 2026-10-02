import type {D1Database} from '@cloudflare/workers-types';
import {encodeBase64Url} from '../../../packages/protocol/src/index.js';
import type {StoredRoomRecord} from './publish-api.js';
import {PublisherStorageError} from './durable-publisher-storage.js';

export type PublisherRoomNamespace = {get(id: any): {fetch(request: Request): Promise<Response>}; idFromName(name: string): any};
type RoomOperation = {publisherKeyId: string; operationId: string; requestDigest: string; roomId: string;
  packageDigest: string; expiresAt: number; state: string; initBody: string; initDigest: string; responseBody: string};
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, app_version_digest TEXT NOT NULL REFERENCES publisher_packages(packageDigest), publisher_id TEXT NOT NULL REFERENCES publishers(id), operation_id TEXT NOT NULL, request_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','ACTIVE')), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revoked_at INTEGER, approximate_bytes INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS publisher_room_operations (publisherKeyId TEXT NOT NULL REFERENCES publishers(key_id), route TEXT NOT NULL CHECK(route='/v1/rooms'), operationId TEXT NOT NULL, requestDigest TEXT NOT NULL, roomId TEXT NOT NULL, packageDigest TEXT NOT NULL REFERENCES publisher_packages(packageDigest), expiresAt INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('D1_PENDING','DO_ACTIVE_WITH_GENESIS','D1_ACTIVE')), initBody TEXT NOT NULL, initDigest TEXT NOT NULL, responseBody TEXT NOT NULL, createdAt INTEGER NOT NULL, checkedAt INTEGER NOT NULL DEFAULT 0, completedAt INTEGER, PRIMARY KEY(publisherKeyId,route,operationId))`,
  `CREATE INDEX IF NOT EXISTS publisher_room_reconcile ON publisher_room_operations(state,checkedAt,createdAt)`,
];
const sha = async (bytes: Uint8Array): Promise<string> => encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const responseBody = (record: Pick<StoredRoomRecord, 'roomId' | 'packageDigest' | 'publisherKeyId' | 'expiresAt'>): string =>
  JSON.stringify({ok: true, roomId: record.roomId, packageDigest: record.packageDigest,
    publisherKeyId: record.publisherKeyId, expiresAt: record.expiresAt});
function fail(status: number, code: string): never { throw new PublisherStorageError(status, code); }

export class DurableRoomStorage {
  private ready: Promise<unknown> | undefined;
  constructor(readonly db: D1Database, readonly ensurePublisherSchema: () => Promise<void>, readonly now = Date.now) {}
  async initialize(): Promise<void> {
    await this.ensurePublisherSchema();
    this.ready ??= this.db.batch(SCHEMA.map((sql) => this.db.prepare(sql)));
    await this.ready;
  }
  private operation(publisherKeyId: string, operationId: string): Promise<RoomOperation | null> {
    return this.db.prepare("SELECT * FROM publisher_room_operations WHERE publisherKeyId=? AND route='/v1/rooms' AND operationId=?")
      .bind(publisherKeyId, operationId).first<RoomOperation>();
  }
  async replay(publisherKeyId: string, operationId: string, requestDigest: string): Promise<string | null> {
    await this.initialize();
    const operation = await this.operation(publisherKeyId, operationId);
    if (!operation) return null;
    if (operation.requestDigest !== requestDigest) fail(409, 'IDEMPOTENCY_MISMATCH');
    if (operation.responseBody !== responseBody(operation)) fail(409, 'ROOM_OPERATION_INVALID');
    if (operation.state !== 'D1_ACTIVE') return null;
    await this.matchingRoom(operation, 'ACTIVE');
    return operation.responseBody;
  }
  async create(record: StoredRoomRecord, operationId: string, requestDigest: string, initBody: string,
    namespace: PublisherRoomNamespace): Promise<{body: string; created: boolean}> {
    const replay = await this.replay(record.publisherKeyId, operationId, requestDigest);
    if (replay) return {body: replay, created: false};
    const bytes = new TextEncoder().encode(initBody);
    if (bytes.byteLength > 724_992) fail(413, 'ROOM_CREATION_SIZE_LIMIT');
    const initDigest = await sha(bytes); const now = this.now();
    const body = responseBody(record);
    await this.db.batch([
      this.db.prepare(`INSERT INTO publisher_room_operations(publisherKeyId,route,operationId,requestDigest,roomId,packageDigest,expiresAt,state,initBody,initDigest,responseBody,createdAt)
        VALUES(?,'/v1/rooms',?,?,?,?,?,'D1_PENDING',?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(record.publisherKeyId, operationId, requestDigest, record.roomId, record.packageDigest, record.expiresAt, initBody, initDigest, body, now),
      this.db.prepare(`INSERT INTO rooms(id,app_version_digest,publisher_id,operation_id,request_digest,status,expires_at,created_at,updated_at)
        SELECT ?,?,?,?,?,'PENDING',?,?,? WHERE EXISTS(SELECT 1 FROM publisher_room_operations WHERE publisherKeyId=? AND route='/v1/rooms' AND operationId=? AND requestDigest=?) ON CONFLICT DO NOTHING`)
        .bind(record.roomId, record.packageDigest, record.publisherKeyId, operationId, requestDigest, record.expiresAt, now, now,
          record.publisherKeyId, operationId, requestDigest),
    ]);
    const operation = await this.operation(record.publisherKeyId, operationId);
    if (!operation || operation.requestDigest !== requestDigest) fail(409, 'IDEMPOTENCY_MISMATCH');
    if (operation.initDigest !== initDigest || operation.responseBody !== body) fail(409, 'ROOM_OPERATION_INVALID');
    await this.converge(operation, namespace);
    return {body: operation.responseBody, created: true};
  }
  private async matchingRoom(operation: RoomOperation, expectedStatus?: string): Promise<void> {
    const room = await this.db.prepare(`SELECT status FROM rooms WHERE id=? AND app_version_digest=? AND publisher_id=? AND operation_id=? AND request_digest=? AND expires_at=?`)
      .bind(operation.roomId, operation.packageDigest, operation.publisherKeyId, operation.operationId, operation.requestDigest, operation.expiresAt)
      .first<{status: string}>();
    if (!room || expectedStatus && room.status !== expectedStatus) fail(409, 'ROOM_CREATION_CONFLICT');
  }
  private async converge(operation: RoomOperation, namespace: PublisherRoomNamespace): Promise<void> {
    await this.matchingRoom(operation);
    const bytes = new TextEncoder().encode(operation.initBody);
    if (bytes.byteLength > 724_992 || await sha(bytes) !== operation.initDigest
      || operation.responseBody !== responseBody(operation)) fail(409, 'ROOM_OPERATION_INVALID');
    const object = namespace.get(namespace.idFromName(operation.roomId));
    const response = await object.fetch(new Request(`http://internal/__publisher/rooms/${operation.roomId}/init-envelope`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: operation.initBody,
    }));
    if (response.status === 409) fail(409, 'INITIALIZATION_CONFLICT');
    if (response.status !== 200 && response.status !== 201) fail(503, 'ROOM_INITIALIZATION_FAILED');
    await this.db.prepare("UPDATE publisher_room_operations SET state='DO_ACTIVE_WITH_GENESIS' WHERE publisherKeyId=? AND route='/v1/rooms' AND operationId=? AND state='D1_PENDING'")
      .bind(operation.publisherKeyId, operation.operationId).run();
    await this.db.batch([
      this.db.prepare("UPDATE rooms SET status='ACTIVE',updated_at=? WHERE id=? AND publisher_id=? AND operation_id=? AND request_digest=?")
        .bind(this.now(), operation.roomId, operation.publisherKeyId, operation.operationId, operation.requestDigest),
      this.db.prepare(`UPDATE publisher_room_operations SET state='D1_ACTIVE',completedAt=COALESCE(completedAt,?) WHERE publisherKeyId=? AND route='/v1/rooms' AND operationId=?
        AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND status='ACTIVE' AND publisher_id=? AND operation_id=? AND request_digest=?)`)
        .bind(this.now(), operation.publisherKeyId, operation.operationId, operation.roomId, operation.publisherKeyId, operation.operationId, operation.requestDigest),
    ]);
    if ((await this.operation(operation.publisherKeyId, operation.operationId))?.state !== 'D1_ACTIVE') fail(409, 'ROOM_CREATION_CONFLICT');
  }
  async cleanup(): Promise<void> {
    await this.initialize();
    await this.db.prepare("DELETE FROM publisher_room_operations WHERE (state='D1_ACTIVE' AND completedAt<?) OR expiresAt<?")
      .bind(this.now() - 86_400_000, this.now() - 86_400_000).run();
  }
  async reconcile(namespace: PublisherRoomNamespace): Promise<{activated: number; pending: number}> {
    await this.initialize();
    const operations = await this.db.prepare("SELECT * FROM publisher_room_operations WHERE state!='D1_ACTIVE' ORDER BY checkedAt,createdAt,operationId LIMIT 100").all<RoomOperation>();
    let activated = 0; let pending = 0;
    for (const operation of operations.results) {
      try { await this.converge(operation, namespace); activated++; } catch { pending++; }
      await this.db.prepare("UPDATE publisher_room_operations SET checkedAt=? WHERE publisherKeyId=? AND route='/v1/rooms' AND operationId=?")
        .bind(this.now(), operation.publisherKeyId, operation.operationId).run();
    }
    return {activated, pending};
  }
}
