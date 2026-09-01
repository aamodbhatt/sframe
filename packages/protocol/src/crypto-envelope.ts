import {getPublicKeyAsync, signAsync, verifyAsync} from '@noble/ed25519';
import canonicalize from 'canonicalize';

export const STATE_CIPHERTEXT_LIMIT = 524_288;
export const ENVELOPE_BODY_LIMIT = 720_896;
export const PADDING_BUCKET_BYTES = 4_096;

export type AadObject = {
  protocolVersion: 1;
  appId: string;
  roomId: string;
  packageDigest: string;
  stateEpoch: number;
  proposedRevision: number;
  previousEnvelopeDigest: string;
};

export type WireEnvelope = {
  version: 1;
  stateEpoch: number;
  proposedRevision: number;
  envelopeSalt: string;
  previousEnvelopeDigest: string;
  ciphertext: string;
  writerPublicKey: string;
  writerSignature: string;
  aad: AadObject;
};

export const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const decodeBase64Url = (str: string): Uint8Array => {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

export const uint32be = (value: number): Uint8Array => {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(0, value, false);
  return buf;
};

export const uint64be = (value: number | bigint): Uint8Array => {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setBigUint64(0, BigInt(value), false);
  return buf;
};

export const concatBytes = (...arrays: Uint8Array[]): Uint8Array => {
  const total = arrays.reduce((acc, a) => acc + a.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
};

export const sha256 = async (data: Uint8Array): Promise<Uint8Array> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
};

export const deriveEnvelopeKey = async (
  roomKey: Uint8Array,
  rawRoomId: Uint8Array,
  envelopeSalt: Uint8Array,
  stateEpoch: number,
  proposedRevision: number
): Promise<CryptoKey> => {
  if (roomKey.byteLength !== 32) throw new Error('ROOM_KEY_LENGTH_INVALID');
  if (envelopeSalt.byteLength !== 16) throw new Error('ENVELOPE_SALT_LENGTH_INVALID');

  const saltPrefix = new TextEncoder().encode('smallframe/state/salt/v1\0');
  const hkdfSalt = await sha256(concatBytes(saltPrefix, rawRoomId, envelopeSalt));

  const infoPrefix = new TextEncoder().encode('smallframe/state/key/v1\0');
  const hkdfInfo = concatBytes(infoPrefix, uint64be(stateEpoch), uint64be(proposedRevision));

  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    roomKey,
    'HKDF',
    false,
    ['deriveKey']
  );

  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: hkdfSalt,
      info: hkdfInfo
    },
    keyMaterial,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  );
};

export const padPlaintext = (automergeBytes: Uint8Array): Uint8Array => {
  const unpaddedLength = 4 + automergeBytes.byteLength;
  const bucketCount = Math.ceil(unpaddedLength / PADDING_BUCKET_BYTES);
  const totalLength = Math.max(PADDING_BUCKET_BYTES, bucketCount * PADDING_BUCKET_BYTES);
  const paddingLength = totalLength - unpaddedLength;

  const lenPrefix = uint32be(automergeBytes.byteLength);
  const padding = new Uint8Array(paddingLength);
  if (paddingLength > 0) {
    globalThis.crypto.getRandomValues(padding);
  }

  return concatBytes(lenPrefix, automergeBytes, padding);
};

export const unpadPlaintext = (padded: Uint8Array): Uint8Array => {
  if (padded.byteLength < 4 || padded.byteLength % PADDING_BUCKET_BYTES !== 0) {
    throw new Error('INVALID_PADDING_LENGTH');
  }
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const declaredLength = view.getUint32(0, false);
  if (declaredLength > padded.byteLength - 4) {
    throw new Error('DECLARED_LENGTH_EXCEEDS_PLAINTEXT');
  }
  const expectedTotal = Math.max(
    PADDING_BUCKET_BYTES,
    Math.ceil((4 + declaredLength) / PADDING_BUCKET_BYTES) * PADDING_BUCKET_BYTES
  );
  if (padded.byteLength !== expectedTotal) {
    throw new Error('NON_CANONICAL_PADDING_BUCKET');
  }
  return padded.slice(4, 4 + declaredLength);
};

export const computeWriteMessage = async (
  rawRoomId: Uint8Array,
  rawPackageDigest: Uint8Array,
  stateEpoch: number,
  proposedRevision: number,
  rawPreviousEnvelopeDigest: Uint8Array,
  envelopeSalt: Uint8Array,
  aadBytes: Uint8Array,
  ciphertextBytes: Uint8Array
): Promise<Uint8Array> => {
  const prefix = new TextEncoder().encode('smallframe-room-snapshot-v1\0');
  const aadHash = await sha256(aadBytes);
  const cipherHash = await sha256(ciphertextBytes);

  return sha256(
    concatBytes(
      prefix,
      rawRoomId,
      rawPackageDigest,
      uint64be(stateEpoch),
      uint64be(proposedRevision),
      rawPreviousEnvelopeDigest,
      envelopeSalt,
      aadHash,
      cipherHash
    )
  );
};

export const computeEnvelopeDigest = async (
  envelopeWithoutSignature: Record<string, unknown>,
  writerSignature: Uint8Array
): Promise<Uint8Array> => {
  const prefix = new TextEncoder().encode('smallframe/envelope-digest/v1\0');
  const unsignedJcs = new TextEncoder().encode(canonicalize(envelopeWithoutSignature)!);
  return sha256(
    concatBytes(
      prefix,
      uint64be(unsignedJcs.byteLength),
      unsignedJcs,
      writerSignature
    )
  );
};

export const computeEtag = (
  stateEpoch: number,
  proposedRevision: number,
  envelopeDigest: Uint8Array
): string => {
  return `"sf1.${stateEpoch}.${proposedRevision}.${encodeBase64Url(envelopeDigest)}"`;
};

export const encryptSnapshot = async (params: {
  roomKey: Uint8Array;
  writerPrivateKey: Uint8Array;
  roomId: string;
  appId: string;
  packageDigest: string;
  stateEpoch: number;
  proposedRevision: number;
  previousEnvelopeDigest: string;
  automergeBytes: Uint8Array;
}): Promise<{
  envelope: WireEnvelope;
  envelopeDigest: Uint8Array;
  etag: string;
}> => {
  const rawRoomId = decodeBase64Url(params.roomId);
  const rawPackageDigest = decodeBase64Url(params.packageDigest);
  const rawPreviousDigest = decodeBase64Url(params.previousEnvelopeDigest);

  const envelopeSalt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(envelopeSalt);

  const derivedKey = await deriveEnvelopeKey(
    params.roomKey,
    rawRoomId,
    envelopeSalt,
    params.stateEpoch,
    params.proposedRevision
  );

  const aad: AadObject = {
    protocolVersion: 1,
    appId: params.appId,
    roomId: params.roomId,
    packageDigest: params.packageDigest,
    stateEpoch: params.stateEpoch,
    proposedRevision: params.proposedRevision,
    previousEnvelopeDigest: params.previousEnvelopeDigest
  };
  const aadBytes = new TextEncoder().encode(canonicalize(aad)!);

  const paddedPlaintext = padPlaintext(params.automergeBytes);
  const nonce = new Uint8Array(12); // fixed 12 zeros

  const encryptedBuffer = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: aadBytes,
      tagLength: 128
    },
    derivedKey,
    paddedPlaintext
  );
  const ciphertextBytes = new Uint8Array(encryptedBuffer);

  if (ciphertextBytes.byteLength > STATE_CIPHERTEXT_LIMIT) {
    throw new Error('STATE_CIPHERTEXT_LIMIT_EXCEEDED');
  }

  const writeMessage = await computeWriteMessage(
    rawRoomId,
    rawPackageDigest,
    params.stateEpoch,
    params.proposedRevision,
    rawPreviousDigest,
    envelopeSalt,
    aadBytes,
    ciphertextBytes
  );

  const writerSignature = await signAsync(writeMessage, params.writerPrivateKey);
  const writerPublicKey = await getPublicKeyAsync(params.writerPrivateKey);

  const envelopeWithoutSig = {
    version: 1 as const,
    stateEpoch: params.stateEpoch,
    proposedRevision: params.proposedRevision,
    envelopeSalt: encodeBase64Url(envelopeSalt),
    previousEnvelopeDigest: params.previousEnvelopeDigest,
    ciphertext: encodeBase64Url(ciphertextBytes),
    writerPublicKey: encodeBase64Url(writerPublicKey),
    aad
  };

  const envelopeDigest = await computeEnvelopeDigest(envelopeWithoutSig, writerSignature);
  const etag = computeEtag(params.stateEpoch, params.proposedRevision, envelopeDigest);

  const envelope: WireEnvelope = {
    ...envelopeWithoutSig,
    writerSignature: encodeBase64Url(writerSignature)
  };

  return {envelope, envelopeDigest, etag};
};

export const decryptSnapshot = async (params: {
  roomKey: Uint8Array;
  expectedWriterPublicKey?: Uint8Array;
  roomId: string;
  packageDigest: string;
  envelope: WireEnvelope;
}): Promise<{
  automergeBytes: Uint8Array;
  envelopeDigest: Uint8Array;
  etag: string;
}> => {
  const {envelope} = params;
  if (envelope.version !== 1) throw new Error('UNSUPPORTED_ENVELOPE_VERSION');
  if (envelope.aad.roomId !== params.roomId) throw new Error('ROOM_ID_AAD_MISMATCH');
  if (envelope.aad.packageDigest !== params.packageDigest) throw new Error('PACKAGE_DIGEST_AAD_MISMATCH');
  if (envelope.aad.stateEpoch !== envelope.stateEpoch || envelope.aad.proposedRevision !== envelope.proposedRevision) {
    throw new Error('EPOCH_REVISION_AAD_MISMATCH');
  }

  const rawRoomId = decodeBase64Url(params.roomId);
  const rawPackageDigest = decodeBase64Url(params.packageDigest);
  const rawPreviousDigest = decodeBase64Url(envelope.previousEnvelopeDigest);
  const envelopeSalt = decodeBase64Url(envelope.envelopeSalt);
  const ciphertextBytes = decodeBase64Url(envelope.ciphertext);
  const writerPublicKey = decodeBase64Url(envelope.writerPublicKey);
  const writerSignature = decodeBase64Url(envelope.writerSignature);

  if (ciphertextBytes.byteLength > STATE_CIPHERTEXT_LIMIT) {
    throw new Error('STATE_CIPHERTEXT_LIMIT_EXCEEDED');
  }

  if (params.expectedWriterPublicKey) {
    if (writerPublicKey.byteLength !== 32 || params.expectedWriterPublicKey.byteLength !== 32) {
      throw new Error('WRITER_KEY_LENGTH_MISMATCH');
    }
    for (let i = 0; i < 32; i++) {
      if (writerPublicKey[i] !== params.expectedWriterPublicKey[i]) {
        throw new Error('WRITER_PUBLIC_KEY_MISMATCH');
      }
    }
  }

  const aadBytes = new TextEncoder().encode(canonicalize(envelope.aad)!);

  const writeMessage = await computeWriteMessage(
    rawRoomId,
    rawPackageDigest,
    envelope.stateEpoch,
    envelope.proposedRevision,
    rawPreviousDigest,
    envelopeSalt,
    aadBytes,
    ciphertextBytes
  );

  const validSig = await verifyAsync(writerSignature, writeMessage, writerPublicKey);
  if (!validSig) throw new Error('INVALID_WRITER_SIGNATURE');

  const derivedKey = await deriveEnvelopeKey(
    params.roomKey,
    rawRoomId,
    envelopeSalt,
    envelope.stateEpoch,
    envelope.proposedRevision
  );

  const nonce = new Uint8Array(12);
  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: aadBytes,
        tagLength: 128
      },
      derivedKey,
      ciphertextBytes
    );
  } catch {
    throw new Error('AUTHENTICATED_DECRYPTION_FAILED');
  }

  const unpaddedAutomerge = unpadPlaintext(new Uint8Array(decryptedBuffer));

  const envelopeWithoutSig = {
    version: 1,
    stateEpoch: envelope.stateEpoch,
    proposedRevision: envelope.proposedRevision,
    envelopeSalt: envelope.envelopeSalt,
    previousEnvelopeDigest: envelope.previousEnvelopeDigest,
    ciphertext: envelope.ciphertext,
    writerPublicKey: envelope.writerPublicKey,
    aad: envelope.aad
  };
  const envelopeDigest = await computeEnvelopeDigest(envelopeWithoutSig, writerSignature);
  const etag = computeEtag(envelope.stateEpoch, envelope.proposedRevision, envelopeDigest);

  return {automergeBytes: unpaddedAutomerge, envelopeDigest, etag};
};
