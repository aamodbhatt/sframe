import {randomBytes} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {handlePublisherRoomStatus} from '../apps/api/src/publisher-room-status.js';
import {handlePublishRoute} from '../apps/api/src/publish-router.js';
import {globalPublishStore, type PublishStore} from '../apps/api/src/publish-api.js';
import type {PublisherRoomNamespace} from '../apps/api/src/durable-room-storage.js';

const fixture = (reply: () => Promise<Response>, pending = false) => {
  const roomId = randomBytes(16).toString('base64url'); const operationId = randomBytes(16).toString('base64url');
  const owned = {id: roomId, app_version_digest: randomBytes(32).toString('base64url'), operation_id: operationId,
    request_digest: randomBytes(32).toString('base64url'), status: pending ? 'PENDING' : 'ACTIVE', expires_at: Date.now() + 1000,
    creation_status: pending ? 'D1_PENDING' : 'D1_ACTIVE'};
  const store = {...globalPublishStore, durable: {publisher: async () => ({publisherKeyId: `sha256:${randomBytes(32).toString('base64url')}`,
    publisherId: randomBytes(16).toString('base64url')}), rooms: {initialize: async () => {}},
    db: {prepare: () => ({bind: () => ({first: async () => owned})})}}} as unknown as PublishStore;
  const namespace = {idFromName: () => roomId, get: () => ({fetch: reply})} as PublisherRoomNamespace;
  const request = new Request(`http://api.localhost/v1/publisher/rooms/${roomId}`, {
    headers: {Authorization: `Bearer ${randomBytes(32).toString('base64url')}`},
  });
  return {roomId, operationId, owned, store, namespace, request};
};
describe('publisher room status fails closed at the DO response boundary', () => {
  it('rejects unknown fields, mismatched context, invalid lifecycle and invalid head tuples', async () => {
    for (const change of [{unexpected: null}, {status: 'UNKNOWN'}, {stateEpoch: 17}, {revision: 0},
      {roomId: randomBytes(16).toString('base64url')}, {operationId: randomBytes(16).toString('base64url')}]) {
      const f = fixture(async () => new Response(JSON.stringify({roomId: f.roomId, operationId: f.operationId,
        status: 'ACTIVE', stateEpoch: 0, revision: 1, ...change})));
      const response = await handlePublisherRoomStatus(f.request, f.roomId, f.namespace, f.store);
      expect(response.status).toBe(503);
      expect((await response.json() as {title: string}).title).toBe('ROOM_STATUS_UNAVAILABLE');
    }
  });
  it('bounds bytes, duplicate fields, transport errors and missing active authority', async () => {
    for (const reply of [async () => new Response('x'.repeat(2049)),
      async () => new Response('{"status":"ACTIVE","status":"EXPIRED"}'),
      async () => new Response(null, {status: 404}), async (): Promise<Response> => {throw new Error('SIMULATED_TRANSPORT_FAILURE');}]) {
      const f = fixture(reply);
      expect((await handlePublisherRoomStatus(f.request, f.roomId, f.namespace, f.store)).status).toBe(503);
    }
  });
  it('rejects corrupted D1 identifiers, lifecycle, expiry and operation metadata before contacting the DO', async () => {
    for (const change of [{app_version_digest: 'invalid'}, {request_digest: 'invalid'}, {operation_id: 'invalid'},
      {status: 'UNKNOWN'}, {expires_at: -1}, {expires_at: 9_007_199_254_740_992}, {creation_status: 'UNKNOWN'}]) {
      let contacted = false;
      const f = fixture(async () => {contacted = true; return new Response(null);});
      Object.assign(f.owned, change);
      expect((await handlePublisherRoomStatus(f.request, f.roomId, f.namespace, f.store)).status).toBe(503);
      expect(contacted).toBe(false);
    }
  });
  it('reports an uninitialized pending operation without promoting the D1 mirror', async () => {
    const f = fixture(async () => new Response(null, {status: 404}), true);
    const response = await handlePublisherRoomStatus(f.request, f.roomId, f.namespace, f.store);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({status: 'PENDING', creationStatus: 'D1_PENDING', stateEpoch: null, revision: null});
    expect(f.owned.status).toBe('PENDING');
  });
  it('keeps production closed before any credentials or storage access', async () => {
    const request = new Request(`https://api.example.com/v1/publisher/rooms/${randomBytes(16).toString('base64url')}`);
    const response = await handlePublishRoute(new URL(request.url).pathname, request, {ENVIRONMENT: 'production',
      ROOMS: {idFromName: () => {throw new Error('UNEXPECTED_DO_ACCESS');}, get: () => {throw new Error('UNEXPECTED_DO_ACCESS');}}});
    expect(response?.status).toBe(503);
  });
});
