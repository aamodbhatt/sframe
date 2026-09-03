import {getPublicKeyAsync, signAsync, verifyAsync} from '@noble/ed25519';
import canonicalize from 'canonicalize';
import {
  decodeBase64Url,
  encodeBase64Url,
  sha256,
  uint32be,
  concatBytes
} from './crypto-envelope.js';

export const DESCRIPTOR_PAYLOAD_TYPE = 'application/vnd.smallframe.room-descriptor.v1+json';
export const MAX_DESCRIPTOR_BYTES = 1_024;
export const MAX_FRAGMENT_BYTES = 4_096;

export type RoomRole = 'viewer' | 'editor';

export type RoomDescriptor = {
  protocolVersion: 1;
  roomId: string;
  packageDigest: string;
  publisherKeyId: string;
  writerPublicKey: string;
  capabilityHash: string;
  role: RoomRole;
  expiresAt: number;
};

export type ParsedInvite = {
  version: 1;
  descriptor: RoomDescriptor;
  descriptorSignature: Uint8Array;
  descriptorDigest: Uint8Array;
  roomKey: Uint8Array;
  capability: Uint8Array;
  writerPrivateSeed?: Uint8Array | undefined;
};

export const dssePae = (payloadType: string, payloadBytes: Uint8Array): Uint8Array => {
  const enc = new TextEncoder();
  const prefix = enc.encode(`DSSEv1 ${payloadType.length} ${payloadType} ${payloadBytes.byteLength} `);
  return concatBytes(prefix, payloadBytes);
};

export const computeDescriptorDigest = async (
  jcsBytes: Uint8Array,
  signature64: Uint8Array
): Promise<Uint8Array> => {
  const prefix = new TextEncoder().encode('smallframe/room-descriptor-digest/v1\0');
  return sha256(concatBytes(prefix, uint32be(jcsBytes.byteLength), jcsBytes, signature64));
};

export const createSignedRoomDescriptor = async (params: {
  publisherPrivateKey: Uint8Array;
  roomId: string;
  packageDigest: string;
  publisherKeyId: string;
  writerPublicKey: Uint8Array;
  capability: Uint8Array;
  role: RoomRole;
  expiresAt: number;
}): Promise<{
  descriptor: RoomDescriptor;
  signature: Uint8Array;
  descriptorDigest: Uint8Array;
  jcsBytes: Uint8Array;
}> => {
  const capabilityHash = encodeBase64Url(await sha256(params.capability));
  const writerPublicKey = encodeBase64Url(params.writerPublicKey);

  const descriptor: RoomDescriptor = {
    protocolVersion: 1,
    roomId: params.roomId,
    packageDigest: params.packageDigest,
    publisherKeyId: params.publisherKeyId,
    writerPublicKey,
    capabilityHash,
    role: params.role,
    expiresAt: params.expiresAt
  };

  const canonical = canonicalize(descriptor);
  if (!canonical) throw new Error('DESCRIPTOR_CANONICALIZATION_FAILED');
  const jcsBytes = new TextEncoder().encode(canonical);
  if (jcsBytes.byteLength > MAX_DESCRIPTOR_BYTES) {
    throw new Error('DESCRIPTOR_TOO_LARGE');
  }

  const pae = dssePae(DESCRIPTOR_PAYLOAD_TYPE, jcsBytes);
  const signature = await signAsync(pae, params.publisherPrivateKey);
  const descriptorDigest = await computeDescriptorDigest(jcsBytes, signature);

  return {descriptor, signature, descriptorDigest, jcsBytes};
};

export const verifyRoomDescriptor = async (
  descriptor: RoomDescriptor,
  signature: Uint8Array,
  publisherPublicKey: Uint8Array
): Promise<{
  valid: boolean;
  descriptorDigest: Uint8Array;
}> => {
  const canonical = canonicalize(descriptor);
  if (!canonical) return {valid: false, descriptorDigest: new Uint8Array(32)};
  const jcsBytes = new TextEncoder().encode(canonical);
  const pae = dssePae(DESCRIPTOR_PAYLOAD_TYPE, jcsBytes);
  const valid = await verifyAsync(signature, pae, publisherPublicKey);
  const descriptorDigest = await computeDescriptorDigest(jcsBytes, signature);
  return {valid, descriptorDigest};
};

export const formatInviteFragment = (params: {
  descriptorJcsBytes: Uint8Array;
  descriptorSignature: Uint8Array;
  roomKey: Uint8Array;
  capability: Uint8Array;
  writerPrivateSeed?: Uint8Array;
}): string => {
  const d = encodeBase64Url(params.descriptorJcsBytes);
  const s = encodeBase64Url(params.descriptorSignature);
  const k = encodeBase64Url(params.roomKey);
  const c = encodeBase64Url(params.capability);

  if (params.writerPrivateSeed) {
    const w = encodeBase64Url(params.writerPrivateSeed);
    return `v=1&d=${d}&s=${s}&w=${w}&k=${k}&c=${c}`;
  }
  return `v=1&d=${d}&s=${s}&k=${k}&c=${c}`;
};

const parseParams = (fragmentString: string): {d: string; s: string; k: string; c: string; w: string | null} => {
  const clean = fragmentString.startsWith('#') ? fragmentString.slice(1) : fragmentString;
  if (new TextEncoder().encode(clean).byteLength > MAX_FRAGMENT_BYTES) {
    throw new Error('FRAGMENT_TOO_LARGE');
  }

  const params = new URLSearchParams(clean);
  const v = params.get('v');
  const d = params.get('d');
  const s = params.get('s');
  const k = params.get('k');
  const c = params.get('c');
  const w = params.get('w');

  if (v !== '1' || !d || !s || !k || !c) {
    throw new Error('INVITE_FRAGMENT_INVALID');
  }

  const allowedKeys = w ? ['v', 'd', 's', 'w', 'k', 'c'] : ['v', 'd', 's', 'k', 'c'];
  const actualKeys = [...params.keys()];
  if (actualKeys.length !== allowedKeys.length || new Set(actualKeys).size !== actualKeys.length || !actualKeys.every((key) => allowedKeys.includes(key))) {
    throw new Error('INVITE_FRAGMENT_UNRECOGNIZED_KEYS');
  }
  if (clean.split('&').some((part) => !/^(v|d|s|w|k|c)=[A-Za-z0-9_-]+$/u.test(part))) throw new Error('INVITE_ENCODING_INVALID');
  return {d, s, k, c, w};
};

const strictBase64 = (value: unknown, size?: number): Uint8Array => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('INVITE_ENCODING_INVALID');
  const bytes = decodeBase64Url(value);
  if (encodeBase64Url(bytes) !== value || (size !== undefined && bytes.length !== size)) throw new Error('INVITE_ENCODING_INVALID');
  return bytes;
};

const parseDescriptor = (bytes: Uint8Array): RoomDescriptor => {
  if (bytes.length > MAX_DESCRIPTOR_BYTES) throw new Error('DESCRIPTOR_TOO_LARGE');
  const json = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  const value = JSON.parse(json) as Record<string, unknown>;
  const keys = ['protocolVersion', 'roomId', 'packageDigest', 'publisherKeyId', 'writerPublicKey', 'capabilityHash', 'role', 'expiresAt'];
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) throw new Error('DESCRIPTOR_SCHEMA_INVALID');
  if (canonicalize(value) !== json) throw new Error('DESCRIPTOR_NOT_CANONICAL');
  if (value.protocolVersion !== 1 || !['viewer', 'editor'].includes(String(value.role)) || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) < 0) throw new Error('DESCRIPTOR_SCHEMA_INVALID');
  strictBase64(value.roomId, 16);
  for (const key of ['packageDigest', 'writerPublicKey', 'capabilityHash']) strictBase64(value[key], 32);
  if (typeof value.publisherKeyId !== 'string' || !value.publisherKeyId.startsWith('sha256:')) throw new Error('DESCRIPTOR_SCHEMA_INVALID');
  strictBase64(value.publisherKeyId.slice(7), 32);
  return value as RoomDescriptor;
};

const resolveWriterKey = async (descriptor: RoomDescriptor, w: string | null): Promise<Uint8Array | undefined> => {
  if (descriptor.role === 'editor' && !w) throw new Error('EDITOR_INVITE_REQUIRES_WRITER_KEY');
  if (descriptor.role === 'viewer' && w) throw new Error('VIEWER_INVITE_CANNOT_HAVE_WRITER_KEY');
  if (!w) return undefined;

  const writerPrivateSeed = strictBase64(w, 32);
  if (writerPrivateSeed.byteLength !== 32) throw new Error('INVALID_WRITER_PRIVATE_SEED');
  const derivedPub = await getPublicKeyAsync(writerPrivateSeed);
  if (encodeBase64Url(derivedPub) !== descriptor.writerPublicKey) {
    throw new Error('WRITER_KEY_DERIVATION_MISMATCH');
  }
  return writerPrivateSeed;
};

export const parseInviteFragment = async (fragmentString: string): Promise<ParsedInvite> => {
  const {d, s, k, c, w} = parseParams(fragmentString);

  const descriptorJcsBytes = strictBase64(d);
  const descriptorSignature = strictBase64(s, 64);
  const roomKey = strictBase64(k, 32);
  const capability = strictBase64(c, 32);

  if (descriptorSignature.byteLength !== 64) throw new Error('INVALID_SIGNATURE_LENGTH');
  if (roomKey.byteLength !== 32) throw new Error('INVALID_ROOM_KEY_LENGTH');
  if (capability.byteLength !== 32) throw new Error('INVALID_CAPABILITY_LENGTH');

  const descriptor = parseDescriptor(descriptorJcsBytes);

  const expectedCapHash = encodeBase64Url(await sha256(capability));
  if (descriptor.capabilityHash !== expectedCapHash) {
    throw new Error('CAPABILITY_HASH_MISMATCH');
  }

  const writerPrivateSeed = await resolveWriterKey(descriptor, w);
  const descriptorDigest = await computeDescriptorDigest(descriptorJcsBytes, descriptorSignature);

  return {
    version: 1,
    descriptor,
    descriptorSignature,
    descriptorDigest,
    roomKey,
    capability,
    writerPrivateSeed
  };
};

/** Call only with metadata from successful, pinned package verification. */
export const authenticateInvite = async (invite: ParsedInvite, metadata: {
  packageDigest: string; publisherKeyId: string; publisherPublicKey: string; declaredMode: string;
}, pathname: string, now = Date.now()): Promise<void> => {
  const descriptor = invite.descriptor;
  if (pathname !== `/r/${descriptor.roomId}`) throw new Error('INVITE_ROOM_PATH_MISMATCH');
  if (descriptor.expiresAt <= now) throw new Error('INVITE_EXPIRED');
  if (metadata.declaredMode !== 'shared' || metadata.packageDigest !== descriptor.packageDigest || metadata.publisherKeyId !== descriptor.publisherKeyId) throw new Error('INVITE_PACKAGE_MISMATCH');
  const key = strictBase64(metadata.publisherPublicKey, 32);
  if (`sha256:${encodeBase64Url(await sha256(key))}` !== descriptor.publisherKeyId) throw new Error('INVITE_PUBLISHER_MISMATCH');
  const verified = await verifyRoomDescriptor(descriptor, invite.descriptorSignature, key);
  if (!verified.valid || encodeBase64Url(verified.descriptorDigest) !== encodeBase64Url(invite.descriptorDigest)) throw new Error('INVITE_SIGNATURE_INVALID');
};

export const verifyInviteRelayContext = (invite: ParsedInvite, value: unknown): void => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ROOM_METADATA_INVALID');
  const meta = value as Record<string, unknown>;
  const keys = ['roomId', 'stateEpoch', 'revision', 'envelopeDigest', 'etag', 'expiresAtMs', 'isRevoked', 'role', 'capabilityHash', 'writerPublicKey', 'packageDigest'];
  if (Object.keys(meta).length !== keys.length || !keys.every((key) => Object.hasOwn(meta, key))
    || !Number.isSafeInteger(meta.stateEpoch) || Number(meta.stateEpoch) < 0 || !Number.isSafeInteger(meta.revision) || Number(meta.revision) < 1
    || typeof meta.etag !== 'string') throw new Error('ROOM_METADATA_INVALID');
  strictBase64(meta.envelopeDigest, 32);
  if (meta.etag !== `"sf1.${meta.stateEpoch}.${meta.revision}.${meta.envelopeDigest}"`) throw new Error('ROOM_METADATA_INVALID');
  const d = invite.descriptor;
  const expected = {roomId: d.roomId, packageDigest: d.packageDigest, writerPublicKey: d.writerPublicKey,
    expiresAtMs: d.expiresAt, role: d.role, capabilityHash: d.capabilityHash, isRevoked: false};
  if (!Object.entries(expected).every(([key, expectedValue]) => meta[key] === expectedValue)) throw new Error('INVITE_RELAY_CONTEXT_MISMATCH');
};

export const scrubAddressBar = (): string => {
  if (typeof window === 'undefined') return '';
  const fragment = window.location.hash;
  if (fragment) {
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      // ignore
    }
  }
  return fragment;
};
