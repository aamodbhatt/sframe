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
  if (actualKeys.length !== allowedKeys.length || !actualKeys.every((key) => allowedKeys.includes(key))) {
    throw new Error('INVITE_FRAGMENT_UNRECOGNIZED_KEYS');
  }
  return {d, s, k, c, w};
};

const resolveWriterKey = async (descriptor: RoomDescriptor, w: string | null): Promise<Uint8Array | undefined> => {
  if (descriptor.role === 'editor' && !w) throw new Error('EDITOR_INVITE_REQUIRES_WRITER_KEY');
  if (descriptor.role === 'viewer' && w) throw new Error('VIEWER_INVITE_CANNOT_HAVE_WRITER_KEY');
  if (!w) return undefined;

  const writerPrivateSeed = decodeBase64Url(w);
  if (writerPrivateSeed.byteLength !== 32) throw new Error('INVALID_WRITER_PRIVATE_SEED');
  const derivedPub = await getPublicKeyAsync(writerPrivateSeed);
  if (encodeBase64Url(derivedPub) !== descriptor.writerPublicKey) {
    throw new Error('WRITER_KEY_DERIVATION_MISMATCH');
  }
  return writerPrivateSeed;
};

export const parseInviteFragment = async (fragmentString: string): Promise<ParsedInvite> => {
  const {d, s, k, c, w} = parseParams(fragmentString);

  const descriptorJcsBytes = decodeBase64Url(d);
  const descriptorSignature = decodeBase64Url(s);
  const roomKey = decodeBase64Url(k);
  const capability = decodeBase64Url(c);

  if (descriptorSignature.byteLength !== 64) throw new Error('INVALID_SIGNATURE_LENGTH');
  if (roomKey.byteLength !== 32) throw new Error('INVALID_ROOM_KEY_LENGTH');
  if (capability.byteLength !== 32) throw new Error('INVALID_CAPABILITY_LENGTH');

  const descriptorJson = new TextDecoder().decode(descriptorJcsBytes);
  const descriptor = JSON.parse(descriptorJson) as RoomDescriptor;
  if (descriptor.protocolVersion !== 1) throw new Error('INVALID_DESCRIPTOR_PROTOCOL');

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
