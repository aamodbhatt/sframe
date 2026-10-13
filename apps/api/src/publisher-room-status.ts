import {authenticatePublisher, type PublishStore} from './publish-api.js';
import type {PublisherRoomNamespace} from './durable-room-storage.js';
import {decodeBase64Url} from './do-crypto.js';
import {readBoundedBody} from './bounded-body.js';
import {parseUniqueJson} from '../../../packages/protocol/src/strict-json.js';

type OwnedRoom = {id: string; app_version_digest: string; operation_id: string; request_digest: string;
  status: string; expires_at: number; creation_status: string | null};
const problem = (status: number, code: string): Response => new Response(JSON.stringify({
  type: `urn:smallframe:error:${code.toLowerCase()}`, title: code, status,
}), {status, headers: {'Content-Type': 'application/problem+json; charset=utf-8', 'Cache-Control': 'no-store'}});
const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store'},
});
const STATUSES = new Set(['ACTIVE', 'RECOVERY_REQUIRED', 'REVOKED', 'EXPIRED']);
const CREATION_STATUSES = new Set(['D1_PENDING', 'DO_ACTIVE_WITH_GENESIS', 'D1_ACTIVE']);
const validRoomPath = (request: Request, roomId: string): boolean =>
  !new URL(request.url).search && decodeBase64Url(roomId, 16)?.length === 16;
const validOwnedRoom = (room: OwnedRoom): boolean =>
  decodeBase64Url(room.id, 16)?.length === 16 && decodeBase64Url(room.app_version_digest, 32)?.length === 32
  && decodeBase64Url(room.operation_id, 16)?.length === 16 && decodeBase64Url(room.request_digest, 32)?.length === 32
  && Number.isSafeInteger(room.expires_at) && room.expires_at >= 0
  && ['PENDING', 'ACTIVE', 'RECOVERY_REQUIRED', 'REVOKED', 'EXPIRED', 'DELETE_PENDING'].includes(room.status)
  && (room.creation_status === null || CREATION_STATUSES.has(room.creation_status));
const validHead = (value: Record<string, unknown>): boolean => {
  if (value.status === 'REVOKED' || value.status === 'EXPIRED') return value.stateEpoch === null && value.revision === null;
  return Number.isSafeInteger(value.stateEpoch) && Number(value.stateEpoch) >= 0 && Number(value.stateEpoch) <= 16
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 1;
};
const verifiedStatus = (value: unknown, room: OwnedRoom): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join() === 'operationId,revision,roomId,stateEpoch,status'
    && v.roomId === room.id && v.operationId === room.operation_id && STATUSES.has(v.status as string) && validHead(v);
};

export const handlePublisherRoomStatus = async (request: Request, roomId: string,
  namespace: PublisherRoomNamespace, store: PublishStore): Promise<Response> => {
  if (request.method !== 'GET') return problem(405, 'METHOD_NOT_ALLOWED');
  if (!validRoomPath(request, roomId)) return problem(400, 'ROOM_PATH_INVALID');
  if (request.headers.has('Origin')) return problem(403, 'ORIGIN_INVALID');
  try {
    const publisher = await authenticatePublisher(request, store);
    if (!publisher) return problem(401, 'UNAUTHORIZED');
    if (!store.durable || !publisher.publisherId) return problem(503, 'PUBLISHER_STORAGE_UNAVAILABLE');
    await store.durable.rooms.initialize();
    const room = await store.durable.db.prepare(`SELECT r.id,r.app_version_digest,r.operation_id,r.request_digest,r.status,r.expires_at,o.state AS creation_status
      FROM rooms r LEFT JOIN publisher_room_operations o ON o.publisherKeyId=? AND o.roomId=r.id AND o.operationId=r.operation_id
      WHERE r.id=? AND r.publisher_id=?`).bind(publisher.publisherKeyId, roomId, publisher.publisherId).first<OwnedRoom>();
    if (!room) return problem(404, 'ROOM_NOT_FOUND');
    if (!validOwnedRoom(room)) return problem(503, 'ROOM_STATUS_UNAVAILABLE');
    const response = await namespace.get(namespace.idFromName(roomId)).fetch(new Request(`http://internal/__publisher/rooms/${roomId}/status`, {
      headers: {'X-Smallframe-Publisher-Key-Id': publisher.publisherKeyId, 'X-Smallframe-Creation-Digest': room.request_digest,
        'X-Smallframe-Package-Digest': room.app_version_digest},
    }));
    const base = {roomId, packageDigest: room.app_version_digest, expiresAt: room.expires_at,
      operationId: room.operation_id, creationStatus: room.creation_status ?? 'RESULT_EXPIRED'};
    if (response.status === 403) return problem(404, 'ROOM_NOT_FOUND');
    if (response.status === 404 && room.status === 'PENDING' && room.creation_status === 'D1_PENDING') {
      return json({...base, status: 'PENDING', d1Status: 'CURRENT', stateEpoch: null, revision: null});
    }
    if (!response.ok) return problem(503, 'ROOM_STATUS_UNAVAILABLE');
    const body = await readBoundedBody(response, 2048);
    if (body.kind !== 'ok') return problem(503, 'ROOM_STATUS_UNAVAILABLE');
    const status = parseUniqueJson(new TextDecoder('utf-8', {fatal: true}).decode(body.body));
    if (!verifiedStatus(status, room)) return problem(503, 'ROOM_STATUS_UNAVAILABLE');
    return json({...base, status: status.status, d1Status: room.status === status.status ? 'CURRENT' : 'STALE',
      stateEpoch: status.stateEpoch, revision: status.revision});
  } catch { return problem(503, 'ROOM_STATUS_UNAVAILABLE'); }
};
