import {
  decodeBase64Url,
  encodeBase64Url,
  verifyPublisherEnrollment,
  verifyRoomDescriptor,
  type PublisherEnrollmentRecord,
  type RoomDescriptor
} from '../../../packages/protocol/src/index.js';
import type {WireEnvelope} from '../../../packages/protocol/src/crypto-envelope.js';
import {parseUniqueJson} from '../../../packages/protocol/src/strict-json.js';
import canonicalize from 'canonicalize';
import {verifyUploadedPackage} from './package-verifier.js';
import {validSignedGenesis} from './publisher-genesis.js';
import {readBoundedBody} from './bounded-body.js';
import {PublisherStorageError, type DurablePublisherStorage} from './durable-publisher-storage.js';

// Temporary local-beta admission cap: larger shared-core CPU probes exceed 10 ms.
// The signed package format/native offline verifier retains its 1 MiB bound.
export const MAX_PACKAGE_UPLOAD_BYTES = 8_192;
const MAX_ENROLLMENT_BODY_BYTES = 2_048;
const MAX_ADMIN_INVITE_BODY_BYTES = 1_024;

export type StoredInvite = {
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
  usedByPublisherKeyId?: string;
};

export type StoredPublisher = {
  publisherKeyId: string;
  publisherPublicKey: string;
  tokenHash: string;
  enrolledAt: number;
};

export type StoredPackageRecord = {
  packageDigest: string;
  artifactDigest: string;
  publisherKeyId: string;
  byteLength: number;
  bytes: Uint8Array;
  createdAt: number;
};

export type StoredRoomRecord = {
  roomId: string;
  packageDigest: string;
  publisherKeyId: string;
  createdAt: number;
  expiresAt: number;
  viewerDescriptor: RoomDescriptor;
  editorDescriptor: RoomDescriptor;
};

export type PublishStore = {
  durable?: DurablePublisherStorage;
  invites: Map<string, StoredInvite>;
  publishers: Map<string, StoredPublisher>; // key: tokenHash
  publishersByKeyId: Map<string, StoredPublisher>; // key: publisherKeyId
  packages: Map<string, StoredPackageRecord>; // key: packageDigest
  rooms: Map<string, StoredRoomRecord>; // key: roomId
  operations: Map<string, {status: string; responseBody: string; requestDigest: string}>;
};

// Global in-memory publish store for local/miniflare execution
export const globalPublishStore: PublishStore = {
  invites: new Map(),
  publishers: new Map(),
  publishersByKeyId: new Map(),
  packages: new Map(),
  rooms: new Map(),
  operations: new Map()
};

const storedPackage = (store: PublishStore, digest: string): Promise<StoredPackageRecord | null | undefined> =>
  store.durable ? store.durable.package(digest) : Promise.resolve(store.packages.get(digest));

const savedResponse = (body: string, status = 200): Response =>
  new Response(body, {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}});

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}
  });

const problem = (status: number, code: string): Response =>
  new Response(
    JSON.stringify({
      type: `urn:smallframe:error:${code.toLowerCase()}`,
      title: code,
      status
    }),
    {
      status,
      headers: {'Content-Type': 'application/problem+json; charset=utf-8', 'Cache-Control': 'no-store'}
    }
  );

export const handleAdminCreateInvite = async (request: Request, store = globalPublishStore): Promise<Response> => {
  try {
    if (request.headers.get('Content-Type') !== 'application/json') return problem(415, 'UNSUPPORTED_MEDIA_TYPE');
    const bounded = await readBoundedBody(request, MAX_ADMIN_INVITE_BODY_BYTES);
    if (bounded.kind === 'too-large') return problem(413, 'ADMIN_INVITE_SIZE_LIMIT');
    if (bounded.kind !== 'ok') return problem(400, 'ADMIN_INVITE_INVALID');
    const {codeBytes, duration} = parseAdminInviteRequest(bounded.body);
    const hash = await crypto.subtle.digest('SHA-256', codeBytes);
    const codeHash = encodeBase64Url(new Uint8Array(hash));
    if (store.invites.has(codeHash)) return problem(409, 'INVITE_CODE_ALREADY_EXISTS');

    const now = Date.now();
    const expiresAt = now + duration;

    const record = {codeHash, createdAt: now, expiresAt};
    if (store.durable) {
      if (!await store.durable.createInvite(record)) return problem(409, 'INVITE_CODE_ALREADY_EXISTS');
    } else store.invites.set(codeHash, record);

    return jsonResponse({ok: true, codeHash, expiresAt}, 201);
  } catch {
    return problem(400, 'ADMIN_INVITE_INVALID');
  }
};

const parseAdminInviteRequest = (bytes: Uint8Array): {codeBytes: Uint8Array; duration: number} => {
  const rawBody = parseUniqueJson(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as Record<string, unknown>;
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)
    || Object.keys(rawBody).length < 1 || Object.keys(rawBody).length > 2
    || !Object.hasOwn(rawBody, 'code')
    || Object.keys(rawBody).some((key) => key !== 'code' && key !== 'expiresInMs')
    || typeof rawBody.code !== 'string') throw new Error('ADMIN_INVITE_INVALID');

  const codeBytes = new TextEncoder().encode(rawBody.code);
  const duration = rawBody.expiresInMs ?? 7 * 86_400_000;
  if (codeBytes.byteLength < 16 || codeBytes.byteLength > 256
    || typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 1 || duration > 7 * 86_400_000) {
    throw new Error('ADMIN_INVITE_INVALID');
  }
  return {codeBytes, duration};
};

export const handleEnrollment = async (request: Request, store = globalPublishStore): Promise<Response> => {
  try {
    if (request.headers.get('Content-Type') !== 'application/json') return problem(415, 'UNSUPPORTED_MEDIA_TYPE');
    const bounded = await readBoundedBody(request, MAX_ENROLLMENT_BODY_BYTES);
    if (bounded.kind === 'too-large') return problem(413, 'ENROLLMENT_SIZE_LIMIT');
    if (bounded.kind !== 'ok') return problem(400, 'ENROLLMENT_PAYLOAD_INVALID');
    const {jcsBytes, signature} = parseEnrollmentRequest(bounded.body);

    const record = await verifyPublisherEnrollment(jcsBytes, signature);

    // Check existing operation for idempotency
    const requestDigest = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bounded.body)));
    if (store.durable) {
      const replay = await store.durable.replayEnrollment(record, requestDigest);
      if (replay) return savedResponse(replay);
      await verifyPublisherEnrollment(jcsBytes, signature, {now: Date.now()});
      const result = await store.durable.enroll(record, requestDigest);
      return savedResponse(result.body, result.created ? 201 : 200);
    }
    const operationKey = `enroll:${record.publisherKeyId}:${record.operationId}`;
    const existingOp = store.operations.get(operationKey);
    if (existingOp) {
      if (existingOp.requestDigest !== requestDigest) return problem(409, 'OPERATION_CONFLICT');
      return new Response(existingOp.responseBody, {
        status: 200,
        headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}
      });
    }
    await verifyPublisherEnrollment(jcsBytes, signature, {now: Date.now()});

    // Check invite code
    const invite = store.invites.get(record.inviteCodeHash);
    if (!invite) return problem(403, 'INVITE_CODE_NOT_FOUND');
    if (invite.usedAt !== undefined) {
      return problem(403, 'INVITE_CODE_ALREADY_USED');
    }
    if (Date.now() > invite.expiresAt) return problem(403, 'INVITE_CODE_EXPIRED');

    // Mark invite used
    invite.usedAt = Date.now();
    invite.usedByPublisherKeyId = record.publisherKeyId;

    const publisherRecord: StoredPublisher = {
      publisherKeyId: record.publisherKeyId,
      publisherPublicKey: record.publisherPublicKey,
      tokenHash: record.tokenHash,
      enrolledAt: Date.now()
    };

    store.publishers.set(record.tokenHash, publisherRecord);
    store.publishersByKeyId.set(record.publisherKeyId, publisherRecord);

    const responseData = {
      ok: true,
      publisherKeyId: record.publisherKeyId,
      enrolledAt: publisherRecord.enrolledAt
    };

    store.operations.set(operationKey, {
      status: 'CONFIRMED',
      responseBody: JSON.stringify(responseData),
      requestDigest
    });

    return jsonResponse(responseData, 201);
  } catch (err) {
    if (err instanceof PublisherStorageError) return problem(err.status, err.code);
    if (store.durable) return problem(400, 'ENROLLMENT_FAILED');
    const msg = err instanceof Error ? err.message : 'ENROLLMENT_FAILED';
    return problem(400, msg);
  }
};

const parseEnrollmentRequest = (bytes: Uint8Array): {jcsBytes: Uint8Array; signature: Uint8Array} => {
  const rawBody = parseUniqueJson(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as Record<string, unknown>;
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)
    || Object.keys(rawBody).length !== 2 || !Object.hasOwn(rawBody, 'jcsBytes')
    || !Object.hasOwn(rawBody, 'signature') || typeof rawBody.jcsBytes !== 'string'
    || rawBody.jcsBytes.length > 1_366 || !canonicalBytes(rawBody.signature, 64)) {
    throw new Error('ENROLLMENT_PAYLOAD_INVALID');
  }
  const jcsBytes = decodeBase64Url(rawBody.jcsBytes);
  if (jcsBytes.byteLength > 1_024 || encodeBase64Url(jcsBytes) !== rawBody.jcsBytes) {
    throw new Error('ENROLLMENT_PAYLOAD_INVALID');
  }
  return {jcsBytes, signature: decodeBase64Url(rawBody.signature)};
};

export const authenticatePublisher = async (
  request: Request,
  store = globalPublishStore
): Promise<StoredPublisher | null> => {
  const auth = request.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;

  const tokenBytes = decodeBase64Url(token);
  if (tokenBytes.length !== 32 || encodeBase64Url(tokenBytes) !== token) return null;
  const hash = await crypto.subtle.digest('SHA-256', tokenBytes);
  const tokenHash = encodeBase64Url(new Uint8Array(hash));

  return store.durable ? store.durable.publisher(tokenHash) : store.publishers.get(tokenHash) ?? null;
};

export const handlePackageUpload = async (request: Request, store = globalPublishStore): Promise<Response> => {
  const publisher = await authenticatePublisher(request, store);
  if (!publisher) return problem(401, 'UNAUTHORIZED');

  try {
    if (request.headers.get('Content-Type') !== 'application/vnd.smallframe.package') return problem(415, 'UNSUPPORTED_MEDIA_TYPE');
    const body = await readBoundedBody(request, MAX_PACKAGE_UPLOAD_BYTES);
    if (body.kind === 'too-large') return problem(413, 'PACKAGE_SIZE_LIMIT');
    if (body.kind !== 'ok') return problem(400, 'PACKAGE_UPLOAD_INVALID');
    const bytes = body.body;
    if (bytes.byteLength < 100) return problem(400, 'PACKAGE_SIZE_INVALID');

    const declaredDigest = request.headers.get('X-Smallframe-Package-Digest');
    if (declaredDigest !== null && !canonicalDigest(declaredDigest)) return problem(400, 'PACKAGE_DIGEST_INVALID');
    const inspected = verifyUploadedPackage(bytes, declaredDigest ?? '', publisher.publisherKeyId);
    const {packageDigest, artifactDigest} = inspected;

    if (store.durable) {
      const operationId = request.headers.get('Idempotency-Key');
      if (!canonicalBytes(operationId, 16)) return problem(400, 'OPERATION_ID_INVALID');
      const requestDigest = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(JSON.stringify({contentType: 'application/vnd.smallframe.package', declaredDigest, artifactDigest})))));
      const result = await store.durable.upload({packageDigest, artifactDigest, publisherKeyId: publisher.publisherKeyId,
        byteLength: bytes.byteLength, bytes, createdAt: Date.now()}, operationId, requestDigest, inspected);
      return savedResponse(result.body, result.created ? 201 : 200);
    }
    const existing = store.packages.get(packageDigest);
    if (existing) {
      if (existing.publisherKeyId !== publisher.publisherKeyId || existing.artifactDigest !== artifactDigest) {
        return problem(409, 'PACKAGE_UPLOAD_CONFLICT');
      }
      return jsonResponse({
        ok: true,
        packageDigest: existing.packageDigest,
        artifactDigest: existing.artifactDigest,
        publisherKeyId: existing.publisherKeyId,
        byteLength: existing.byteLength
      }, 200);
    }

    const packageRecord: StoredPackageRecord = {
      packageDigest,
      artifactDigest,
      publisherKeyId: publisher.publisherKeyId,
      byteLength: bytes.byteLength,
      bytes: new Uint8Array(bytes),
      createdAt: Date.now()
    };

    store.packages.set(packageDigest, packageRecord);

    return jsonResponse({
      ok: true,
      packageDigest,
      artifactDigest,
      publisherKeyId: publisher.publisherKeyId,
      byteLength: bytes.byteLength
    }, 201);
  } catch (error) {
    if (error instanceof PublisherStorageError) return problem(error.status, error.code);
    return problem(400, 'PACKAGE_UPLOAD_INVALID');
  }
};

const canonicalDigest = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length !== 43 || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try { return encodeBase64Url(decodeBase64Url(value)) === value; } catch { return false; }
};

export const handleGetPackage = async (packageDigest: string, store = globalPublishStore): Promise<Response> => {
  let record: StoredPackageRecord | null | undefined;
  try { record = store.durable ? await store.durable.package(packageDigest) : store.packages.get(packageDigest); } catch { return problem(409, 'STORED_PACKAGE_INVALID'); }
  if (!record) return problem(404, 'PACKAGE_NOT_FOUND');
  return servePackageSnapshot(record, packageDigest);
};

const servePackageSnapshot = async (record: StoredPackageRecord, packageDigest: string): Promise<Response> => {
  const {packageDigest: logicalDigest, artifactDigest, publisherKeyId, byteLength, bytes} = record;
  if (!canonicalDigest(logicalDigest) || !canonicalDigest(artifactDigest) || logicalDigest !== packageDigest
    || !(bytes instanceof Uint8Array) || !Number.isSafeInteger(byteLength) || bytes.byteLength !== byteLength
    || byteLength > MAX_PACKAGE_UPLOAD_BYTES || byteLength < 100
    || typeof publisherKeyId !== 'string' || !publisherKeyId.startsWith('sha256:') || !canonicalDigest(publisherKeyId.slice(7))) {
    return problem(409, 'STORED_PACKAGE_INVALID');
  }
  // Hash and serve one bounded immutable snapshot even if prototype storage is
  // changed during the WebCrypto await. Literal bytes bind artifactDigest.
  const snapshot = new Uint8Array(bytes);
  if (encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', snapshot))) !== artifactDigest) return problem(409, 'STORED_PACKAGE_INVALID');

  return new Response(snapshot, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.smallframe.package',
      'X-Smallframe-Package-Digest': logicalDigest,
      'X-Smallframe-Artifact-Digest': artifactDigest,
      'X-Smallframe-Publisher-Key-Id': publisherKeyId,
      'Access-Control-Expose-Headers': 'X-Smallframe-Package-Digest, X-Smallframe-Artifact-Digest, X-Smallframe-Publisher-Key-Id',
      'Cache-Control': 'private, no-store'
    }
  });
};

export const handlePublisherGetPackage = async (request: Request, packageDigest: string, store = globalPublishStore): Promise<Response> => {
  const publisher = await authenticatePublisher(request, store);
  if (!publisher) return problem(401, 'UNAUTHORIZED');
  let record: StoredPackageRecord | null | undefined;
  try { record = store.durable ? await store.durable.package(packageDigest) : store.packages.get(packageDigest); }
  catch { return problem(409, 'STORED_PACKAGE_INVALID'); }
  if (!record || record.publisherKeyId !== publisher.publisherKeyId) return problem(404, 'PACKAGE_NOT_FOUND');
  return servePackageSnapshot(record, packageDigest);
};

type RoomCreationBody = {
  operationId: string; roomId: string; packageDigest: string;
  viewerDescriptorJcs: string; viewerDescriptorSignature: string;
  editorDescriptorJcs: string; editorDescriptorSignature: string;
  envelope: WireEnvelope;
};

const parseRoomCreationBody = (bytes: Uint8Array): RoomCreationBody => {
  const body = parseUniqueJson(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as RoomCreationBody;
  const fields = ['operationId', 'roomId', 'packageDigest', 'viewerDescriptorJcs', 'viewerDescriptorSignature',
    'editorDescriptorJcs', 'editorDescriptorSignature', 'envelope'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== fields.length
    || !fields.every((key) => Object.hasOwn(body, key)) || !canonicalDigest(body.packageDigest)
    || !canonicalBytes(body.roomId, 16) || !canonicalBytes(body.operationId, 16)) {
    throw new Error('ROOM_CREATION_PAYLOAD_INVALID');
  }
  return body;
};

const roomDescriptorContextValid = (body: RoomCreationBody, publisher: StoredPublisher,
  viewer: RoomDescriptor, editor: RoomDescriptor): boolean => {
  const now = Date.now();
  return viewer.role === 'viewer' && editor.role === 'editor'
    && viewer.roomId === body.roomId && editor.roomId === body.roomId
    && viewer.publisherKeyId === publisher.publisherKeyId && editor.publisherKeyId === publisher.publisherKeyId
    && viewer.packageDigest === body.packageDigest && editor.packageDigest === body.packageDigest
    && viewer.writerPublicKey === editor.writerPublicKey && viewer.expiresAt === editor.expiresAt
    && Number.isSafeInteger(viewer.expiresAt) && viewer.expiresAt > now
    && viewer.expiresAt <= now + 30 * 86_400_000 && viewer.capabilityHash !== editor.capabilityHash;
};

const genesisContextValid = (body: RoomCreationBody, editor: RoomDescriptor): boolean => {
  const envelope = body.envelope;
  return !!envelope && typeof envelope === 'object' && !Array.isArray(envelope)
    && envelope.aad?.roomId === body.roomId && envelope.aad?.packageDigest === body.packageDigest
    && envelope.writerPublicKey === editor.writerPublicKey && envelope.stateEpoch === 0
    && envelope.revision === 1;
};

const verifyRoomCreationContext = async (body: RoomCreationBody, publisher: StoredPublisher): Promise<{
  viewer: RoomDescriptor; editor: RoomDescriptor;
}> => {
  const pubKey = decodeBase64Url(publisher.publisherPublicKey);
  const viewer = parseCanonicalDescriptor(body.viewerDescriptorJcs);
  const editor = parseCanonicalDescriptor(body.editorDescriptorJcs);
  const viewerSig = decodeCanonicalFixed(body.viewerDescriptorSignature, 64);
  const editorSig = decodeCanonicalFixed(body.editorDescriptorSignature, 64);
  if (!(await verifyRoomDescriptor(viewer, viewerSig, pubKey)).valid
    || !(await verifyRoomDescriptor(editor, editorSig, pubKey)).valid) throw new Error('ROOM_DESCRIPTOR_SIGNATURE_INVALID');
  if (!roomDescriptorContextValid(body, publisher, viewer, editor)) throw new Error('ROOM_CONTEXT_MISMATCH');
  if (!genesisContextValid(body, editor) || !await validSignedGenesis(body.envelope, body.roomId, body.packageDigest, editor.writerPublicKey)) throw new Error('GENESIS_CONTEXT_INVALID');
  return {viewer, editor};
};

export const handleRoomCreationSaga = async (
  request: Request,
  env: {ROOMS: {get: (id: any) => {fetch: (req: Request) => Promise<Response>}; idFromName: (name: string) => any}},
  store = globalPublishStore
): Promise<Response> => {
  const publisher = await authenticatePublisher(request, store);
  if (!publisher) return problem(401, 'UNAUTHORIZED');

  try {
    if (request.headers.get('Content-Type') !== 'application/json') return problem(415, 'UNSUPPORTED_MEDIA_TYPE');
    const bounded = await readBoundedBody(request, 724_992);
    if (bounded.kind === 'too-large') return problem(413, 'ROOM_CREATION_SIZE_LIMIT');
    if (bounded.kind !== 'ok') return problem(400, 'ROOM_CREATION_PAYLOAD_INVALID');
    const rawBody = parseRoomCreationBody(bounded.body);

    const requestDigest = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bounded.body)));
    if (store.durable) {
      const replay = await store.durable.rooms.replay(publisher.publisherKeyId, rawBody.operationId, requestDigest);
      if (replay) return savedResponse(replay);
    }
    const operationKey = `room:${publisher.publisherKeyId}:${rawBody.operationId}`;
    const existingOp = store.operations.get(operationKey);
    if (existingOp) {
      if (existingOp.requestDigest !== requestDigest) return problem(409, 'OPERATION_CONFLICT');
      return new Response(existingOp.responseBody, {
        status: 200,
        headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}
      });
    }

    const packageRecord = await storedPackage(store, rawBody.packageDigest);
    if (!packageRecord || packageRecord.publisherKeyId !== publisher.publisherKeyId) return problem(404, 'PACKAGE_NOT_FOUND');
    if (!(await handleGetPackage(rawBody.packageDigest, store)).ok) return problem(409, 'STORED_PACKAGE_INVALID');

    const {viewer: viewerDesc, editor: editorDesc} = await verifyRoomCreationContext(rawBody, publisher);

    if (store.durable) {
      const result = await store.durable.rooms.create({roomId: rawBody.roomId, packageDigest: rawBody.packageDigest,
        publisherKeyId: publisher.publisherKeyId, createdAt: Date.now(), expiresAt: editorDesc.expiresAt,
        viewerDescriptor: viewerDesc, editorDescriptor: editorDesc}, rawBody.operationId, requestDigest, JSON.stringify({
          viewerCapHash: viewerDesc.capabilityHash, editorCapHash: editorDesc.capabilityHash, expiresAtMs: editorDesc.expiresAt,
          envelope: rawBody.envelope, operationId: rawBody.operationId, requestDigest, publisherKeyId: publisher.publisherKeyId,
        }), env.ROOMS);
      return savedResponse(result.body, result.created ? 201 : 200);
    }

    // Initialize the Durable Object for this room
    const doObj = env.ROOMS.get(env.ROOMS.idFromName(rawBody.roomId));
    const initReq = new Request(`http://api.localhost:8787/__phase0/rooms/${rawBody.roomId}/init-envelope`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        viewerCapHash: viewerDesc.capabilityHash,
        editorCapHash: editorDesc.capabilityHash,
        expiresAtMs: editorDesc.expiresAt,
        envelope: rawBody.envelope
      })
    });

    const initRes = await doObj.fetch(initReq);
    if (initRes.status === 409) return problem(409, 'INITIALIZATION_CONFLICT');
    if (!initRes.ok) return problem(400, 'ROOM_INITIALIZATION_FAILED');

    const roomRecord: StoredRoomRecord = {
      roomId: rawBody.roomId,
      packageDigest: rawBody.packageDigest,
      publisherKeyId: publisher.publisherKeyId,
      createdAt: Date.now(),
      expiresAt: editorDesc.expiresAt,
      viewerDescriptor: viewerDesc,
      editorDescriptor: editorDesc
    };

    store.rooms.set(rawBody.roomId, roomRecord);

    const responseData = {
      ok: true,
      roomId: rawBody.roomId,
      packageDigest: rawBody.packageDigest,
      publisherKeyId: publisher.publisherKeyId,
      expiresAt: roomRecord.expiresAt
    };

    store.operations.set(operationKey, {
      status: 'CONFIRMED',
      responseBody: JSON.stringify(responseData),
      requestDigest
    });

    return jsonResponse(responseData, 201);
  } catch (error) {
    if (error instanceof PublisherStorageError) return problem(error.status, error.code);
    return problem(400, 'ROOM_CREATION_PAYLOAD_INVALID');
  }
};

const canonicalBytes = (value: unknown, length: number): value is string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try { const bytes = decodeBase64Url(value); return bytes.length === length && encodeBase64Url(bytes) === value; } catch { return false; }
};

const decodeCanonicalFixed = (value: unknown, length: number): Uint8Array => {
  if (!canonicalBytes(value, length)) throw new Error('ROOM_CREATION_PAYLOAD_INVALID');
  return decodeBase64Url(value);
};

const parseCanonicalDescriptor = (encoded: unknown): RoomDescriptor => {
  if (typeof encoded !== 'string' || encoded.length > 1366) throw new Error('ROOM_DESCRIPTOR_INVALID');
  const bytes = decodeBase64Url(encoded);
  if (bytes.length > 1024 || encodeBase64Url(bytes) !== encoded) throw new Error('ROOM_DESCRIPTOR_INVALID');
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const value = parseUniqueJson(text) as RoomDescriptor;
  if (!value || typeof value !== 'object' || Array.isArray(value) || canonicalize(value) !== text
    || Object.keys(value).length !== 8
    || !['protocolVersion', 'roomId', 'packageDigest', 'publisherKeyId', 'writerPublicKey', 'capabilityHash', 'role', 'expiresAt']
      .every((key) => Object.hasOwn(value, key))) throw new Error('ROOM_DESCRIPTOR_INVALID');
  return value;
};
