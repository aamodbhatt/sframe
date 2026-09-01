import {
  decodeBase64Url,
  encodeBase64Url,
  verifyPublisherEnrollment,
  verifyRoomDescriptor,
  type PublisherEnrollmentRecord,
  type RoomDescriptor
} from '../../../packages/protocol/src/index.js';

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
  invites: Map<string, StoredInvite>;
  publishers: Map<string, StoredPublisher>; // key: tokenHash
  publishersByKeyId: Map<string, StoredPublisher>; // key: publisherKeyId
  packages: Map<string, StoredPackageRecord>; // key: packageDigest
  rooms: Map<string, StoredRoomRecord>; // key: roomId
  operations: Map<string, {status: string; responseBody: string}>;
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
    const rawBody = (await request.json()) as {code: string; expiresInMs?: number};
    if (!rawBody?.code || typeof rawBody.code !== 'string') return problem(400, 'INVITE_CODE_REQUIRED');

    const codeBytes = new TextEncoder().encode(rawBody.code);
    const hash = await crypto.subtle.digest('SHA-256', codeBytes);
    const codeHash = encodeBase64Url(new Uint8Array(hash));

    const now = Date.now();
    const expiresAt = now + (rawBody.expiresInMs ?? 7 * 86_400_000);

    store.invites.set(codeHash, {
      codeHash,
      createdAt: now,
      expiresAt
    });

    return jsonResponse({ok: true, codeHash, expiresAt}, 201);
  } catch {
    return problem(400, 'ADMIN_INVITE_INVALID');
  }
};

export const handleEnrollment = async (request: Request, store = globalPublishStore): Promise<Response> => {
  try {
    const rawBody = (await request.json()) as {jcsBytes: string; signature: string};
    if (!rawBody?.jcsBytes || !rawBody?.signature) return problem(400, 'ENROLLMENT_PAYLOAD_MISSING');

    const jcsBytes = decodeBase64Url(rawBody.jcsBytes);
    const signature = decodeBase64Url(rawBody.signature);

    const record = await verifyPublisherEnrollment(jcsBytes, signature, {now: Date.now()});

    // Check existing operation for idempotency
    const existingOp = store.operations.get(record.operationId);
    if (existingOp) {
      return new Response(existingOp.responseBody, {
        status: 200,
        headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}
      });
    }

    // Check invite code
    const invite = store.invites.get(record.inviteCodeHash);
    if (!invite) return problem(403, 'INVITE_CODE_NOT_FOUND');
    if (invite.usedAt && invite.usedByPublisherKeyId !== record.publisherKeyId) {
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

    store.operations.set(record.operationId, {
      status: 'CONFIRMED',
      responseBody: JSON.stringify(responseData)
    });

    return jsonResponse(responseData, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'ENROLLMENT_FAILED';
    return problem(400, msg);
  }
};

export const authenticatePublisher = async (
  request: Request,
  store = globalPublishStore
): Promise<StoredPublisher | null> => {
  const auth = request.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;

  const tokenBytes = decodeBase64Url(token);
  const hash = await crypto.subtle.digest('SHA-256', tokenBytes);
  const tokenHash = encodeBase64Url(new Uint8Array(hash));

  return store.publishers.get(tokenHash) ?? null;
};

export const handlePackageUpload = async (request: Request, store = globalPublishStore): Promise<Response> => {
  const publisher = await authenticatePublisher(request, store);
  if (!publisher) return problem(401, 'UNAUTHORIZED');

  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength < 100 || bytes.byteLength > 1_310_720) return problem(400, 'PACKAGE_SIZE_INVALID');

    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const packageDigest = encodeBase64Url(new Uint8Array(digest));
    const artifactDigest = packageDigest;

    const existing = store.packages.get(packageDigest);
    if (existing) {
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
      bytes,
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
  } catch {
    return problem(400, 'PACKAGE_UPLOAD_INVALID');
  }
};

export const handleGetPackage = async (packageDigest: string, store = globalPublishStore): Promise<Response> => {
  const record = store.packages.get(packageDigest);
  if (!record) return problem(404, 'PACKAGE_NOT_FOUND');

  return new Response(record.bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.smallframe.package',
      'X-Smallframe-Package-Digest': record.packageDigest,
      'X-Smallframe-Publisher-Key-Id': record.publisherKeyId,
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  });
};

export const handleRoomCreationSaga = async (
  request: Request,
  env: {ROOMS: {get: (id: any) => {fetch: (req: Request) => Promise<Response>}; idFromName: (name: string) => any}},
  store = globalPublishStore
): Promise<Response> => {
  const publisher = await authenticatePublisher(request, store);
  if (!publisher) return problem(401, 'UNAUTHORIZED');

  try {
    const rawBody = (await request.json()) as {
      operationId: string;
      roomId: string;
      packageDigest: string;
      viewerDescriptorJcs: string;
      viewerDescriptorSignature: string;
      editorDescriptorJcs: string;
      editorDescriptorSignature: string;
      genesisStateBytes: string;
    };

    if (!rawBody?.operationId || !rawBody?.roomId || !rawBody?.packageDigest) {
      return problem(400, 'ROOM_CREATION_PAYLOAD_INVALID');
    }

    // Idempotency check
    const existingOp = store.operations.get(rawBody.operationId);
    if (existingOp) {
      return new Response(existingOp.responseBody, {
        status: 200,
        headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}
      });
    }

    const pubKeyBytes = decodeBase64Url(publisher.publisherPublicKey);

    const viewerDesc = JSON.parse(new TextDecoder().decode(decodeBase64Url(rawBody.viewerDescriptorJcs))) as RoomDescriptor;
    const viewerSig = decodeBase64Url(rawBody.viewerDescriptorSignature);
    const viewerVerify = await verifyRoomDescriptor(viewerDesc, viewerSig, pubKeyBytes);
    if (!viewerVerify.valid) return problem(400, 'VIEWER_DESCRIPTOR_SIGNATURE_INVALID');

    const editorDesc = JSON.parse(new TextDecoder().decode(decodeBase64Url(rawBody.editorDescriptorJcs))) as RoomDescriptor;
    const editorSig = decodeBase64Url(rawBody.editorDescriptorSignature);
    const editorVerify = await verifyRoomDescriptor(editorDesc, editorSig, pubKeyBytes);
    if (!editorVerify.valid) return problem(400, 'EDITOR_DESCRIPTOR_SIGNATURE_INVALID');

    if (viewerDesc.role !== 'viewer' || editorDesc.role !== 'editor') {
      return problem(400, 'ROOM_DESCRIPTOR_ROLES_INVALID');
    }
    if (viewerDesc.roomId !== rawBody.roomId || editorDesc.roomId !== rawBody.roomId) {
      return problem(400, 'ROOM_ID_MISMATCH');
    }
    if (viewerDesc.publisherKeyId !== publisher.publisherKeyId || editorDesc.publisherKeyId !== publisher.publisherKeyId) {
      return problem(403, 'PUBLISHER_KEY_MISMATCH');
    }

    // Initialize the Durable Object for this room
    const doObj = env.ROOMS.get(env.ROOMS.idFromName(rawBody.roomId));
    const initReq = new Request(`http://api.localhost:8787/__phase0/rooms/${rawBody.roomId}/init`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        viewerCapHash: viewerDesc.capabilityHash,
        editorCapHash: editorDesc.capabilityHash,
        expiresAtMs: editorDesc.expiresAt,
        ciphertext: rawBody.genesisStateBytes
      })
    });

    const initRes = await doObj.fetch(initReq);
    if (!initRes.ok && initRes.status !== 409) {
      return problem(500, 'ROOM_INITIALIZATION_FAILED');
    }

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

    store.operations.set(rawBody.operationId, {
      status: 'CONFIRMED',
      responseBody: JSON.stringify(responseData)
    });

    return jsonResponse(responseData, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'ROOM_CREATION_FAILED';
    return problem(400, msg);
  }
};
