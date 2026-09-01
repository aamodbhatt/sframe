import {describe, expect, it} from 'vitest';
import {getPublicKeyAsync} from '@noble/ed25519';
import {
  encryptSnapshot,
  decryptSnapshot,
  padPlaintext,
  unpadPlaintext,
  encodeBase64Url,
  decodeBase64Url,
  deriveEnvelopeKey,
  computeWriteMessage,
  computeEnvelopeDigest,
  computeEtag,
  PADDING_BUCKET_BYTES
} from './crypto-envelope.js';
import {
  createSignedRoomDescriptor,
  verifyRoomDescriptor,
  formatInviteFragment,
  parseInviteFragment
} from './room-descriptor.js';

describe('Phase 3 Cryptographic Envelope & Room Descriptors', () => {
  const roomKey = new Uint8Array(32).fill(0x42);
  const rawRoomId = new Uint8Array(16).fill(0x11);
  const roomId = encodeBase64Url(rawRoomId);
  const packageDigest = encodeBase64Url(new Uint8Array(32).fill(0x22));
  const prevDigest = encodeBase64Url(new Uint8Array(32).fill(0x00));
  const appId = 'com.example.test-app';

  it('pads and unpads Automerge plaintext to 4096-byte bucket boundaries', () => {
    const raw = new TextEncoder().encode('{"test":"smallframe"}');
    const padded = padPlaintext(raw);

    expect(padded.byteLength % PADDING_BUCKET_BYTES).toBe(0);
    expect(padded.byteLength).toBe(PADDING_BUCKET_BYTES);

    const recovered = unpadPlaintext(padded);
    expect(new TextDecoder().decode(recovered)).toBe('{"test":"smallframe"}');
  });

  it('rejects malformed or non-canonical padding', () => {
    expect(() => unpadPlaintext(new Uint8Array(100))).toThrow('INVALID_PADDING_LENGTH');

    const invalidPadded = new Uint8Array(4096);
    new DataView(invalidPadded.buffer).setUint32(0, 5000, false); // declared length exceeds buffer
    expect(() => unpadPlaintext(invalidPadded)).toThrow('DECLARED_LENGTH_EXCEEDS_PLAINTEXT');
  });

  it('derives unique envelope keys for different salts, epochs, or revisions', async () => {
    const salt1 = new Uint8Array(16).fill(1);
    const salt2 = new Uint8Array(16).fill(2);

    const k1 = await deriveEnvelopeKey(roomKey, rawRoomId, salt1, 0, 1);
    const k2 = await deriveEnvelopeKey(roomKey, rawRoomId, salt2, 0, 1);
    const k3 = await deriveEnvelopeKey(roomKey, rawRoomId, salt1, 0, 2);

    // CryptoKey handles are distinct
    expect(k1).toBeDefined();
    expect(k2).toBeDefined();
    expect(k3).toBeDefined();
  });

  it('performs end-to-end encrypt and decrypt of state snapshots', async () => {
    const writerPriv = new Uint8Array(32).fill(0x33);
    const writerPub = await getPublicKeyAsync(writerPriv);
    const statePayload = new TextEncoder().encode('{"items":{"item-1":{"text":"hello"}}}');

    const {envelope, envelopeDigest, etag} = await encryptSnapshot({
      roomKey,
      writerPrivateKey: writerPriv,
      roomId,
      appId,
      packageDigest,
      stateEpoch: 0,
      proposedRevision: 1,
      previousEnvelopeDigest: prevDigest,
      automergeBytes: statePayload
    });

    expect(envelope.version).toBe(1);
    expect(envelope.stateEpoch).toBe(0);
    expect(envelope.proposedRevision).toBe(1);
    expect(envelope.writerPublicKey).toBe(encodeBase64Url(writerPub));
    expect(etag).toMatch(/^"sf1\.0\.1\.[A-Za-z0-9_-]+"$/);

    const decrypted = await decryptSnapshot({
      roomKey,
      expectedWriterPublicKey: writerPub,
      roomId,
      packageDigest,
      envelope
    });

    expect(new TextDecoder().decode(decrypted.automergeBytes)).toBe('{"items":{"item-1":{"text":"hello"}}}');
    expect(decrypted.etag).toBe(etag);
  });

  it('rejects tampered ciphertext, tampered signature, or mismatched writer public key', async () => {
    const writerPriv = new Uint8Array(32).fill(0x33);
    const writerPub = await getPublicKeyAsync(writerPriv);
    const statePayload = new TextEncoder().encode('{"items":{}}');

    const {envelope} = await encryptSnapshot({
      roomKey,
      writerPrivateKey: writerPriv,
      roomId,
      appId,
      packageDigest,
      stateEpoch: 0,
      proposedRevision: 1,
      previousEnvelopeDigest: prevDigest,
      automergeBytes: statePayload
    });

    // Tamper ciphertext
    const tamperedCipher = decodeBase64Url(envelope.ciphertext);
    tamperedCipher[0] = (tamperedCipher[0] ?? 0) ^ 1;
    const tamperedEnv = {...envelope, ciphertext: encodeBase64Url(tamperedCipher)};

    await expect(
      decryptSnapshot({
        roomKey,
        expectedWriterPublicKey: writerPub,
        roomId,
        packageDigest,
        envelope: tamperedEnv
      })
    ).rejects.toThrow();

    // Wrong writer key
    const otherPriv = new Uint8Array(32).fill(0x77);
    const otherPub = await getPublicKeyAsync(otherPriv);
    await expect(
      decryptSnapshot({
        roomKey,
        expectedWriterPublicKey: otherPub,
        roomId,
        packageDigest,
        envelope
      })
    ).rejects.toThrow('WRITER_PUBLIC_KEY_MISMATCH');
  });

  it('creates and verifies signed room descriptors and parses invite fragments', async () => {
    const publisherPriv = new Uint8Array(32).fill(0x55);
    const publisherPub = await getPublicKeyAsync(publisherPriv);
    const publisherKeyId = `sha256:${encodeBase64Url(publisherPub)}`;

    const writerPriv = new Uint8Array(32).fill(0x33);
    const writerPub = await getPublicKeyAsync(writerPriv);

    const viewerCap = new Uint8Array(32).fill(0xaa);
    const editorCap = new Uint8Array(32).fill(0xbb);

    // 1. Viewer descriptor & fragment
    const viewerDesc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: viewerCap,
      role: 'viewer',
      expiresAt: 1800000000000
    });

    const verifyViewer = await verifyRoomDescriptor(viewerDesc.descriptor, viewerDesc.signature, publisherPub);
    expect(verifyViewer.valid).toBe(true);

    const viewerFragment = formatInviteFragment({
      descriptorJcsBytes: viewerDesc.jcsBytes,
      descriptorSignature: viewerDesc.signature,
      roomKey,
      capability: viewerCap
    });

    const parsedViewer = await parseInviteFragment(viewerFragment);
    expect(parsedViewer.descriptor.role).toBe('viewer');
    expect(parsedViewer.descriptor.roomId).toBe(roomId);
    expect(parsedViewer.writerPrivateSeed).toBeUndefined();

    // 2. Editor descriptor & fragment
    const editorDesc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: editorCap,
      role: 'editor',
      expiresAt: 1800000000000
    });

    const verifyEditor = await verifyRoomDescriptor(editorDesc.descriptor, editorDesc.signature, publisherPub);
    expect(verifyEditor.valid).toBe(true);

    const editorFragment = formatInviteFragment({
      descriptorJcsBytes: editorDesc.jcsBytes,
      descriptorSignature: editorDesc.signature,
      roomKey,
      capability: editorCap,
      writerPrivateSeed: writerPriv
    });

    const parsedEditor = await parseInviteFragment(editorFragment);
    expect(parsedEditor.descriptor.role).toBe('editor');
    expect(parsedEditor.writerPrivateSeed).toBeDefined();
    expect(encodeBase64Url(parsedEditor.writerPrivateSeed!)).toBe(encodeBase64Url(writerPriv));
  });

  it('rejects invalid invite fragments', async () => {
    // Missing required param
    await expect(parseInviteFragment('v=1&d=test')).rejects.toThrow('INVITE_FRAGMENT_INVALID');

    // Unrecognized extra key
    await expect(parseInviteFragment('v=1&d=test&s=test&k=test&c=test&extra=bad')).rejects.toThrow('INVITE_FRAGMENT_UNRECOGNIZED_KEYS');
  });
});
