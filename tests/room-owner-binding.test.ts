import {createHash, randomBytes} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {compatibleLegacyRoomInitialization, parseRoomOwnerBinding, roomOwnerKeyMatches} from '../apps/api/src/room-owner-binding.js';
const encoded = (n: number) => randomBytes(n).toString('base64url');
const owner = () => ({publisherPublicKey: encoded(32), viewerDescriptorDigest: encoded(32), editorDescriptorDigest: encoded(32)});

describe('immutable room publisher/descriptor binding', () => {
  it('requires the exact canonical public fields and binds the publisher key ID', async () => {
    const binding = owner(); const keyId = `sha256:${createHash('sha256').update(Buffer.from(binding.publisherPublicKey, 'base64url')).digest('base64url')}`;
    expect(parseRoomOwnerBinding(binding)).toEqual(binding);
    expect(await roomOwnerKeyMatches(binding, keyId)).toBe(true);
    expect(await roomOwnerKeyMatches(binding, `sha256:${encoded(32)}`)).toBe(false);
    for (const malformed of [null, [], 'invalid', {...binding, extra: true}, {...binding, publisherPublicKey: encoded(31)},
      {...binding, viewerDescriptorDigest: binding.viewerDescriptorDigest + '='}, {...binding, editorDescriptorDigest: ''}]) {
      expect(parseRoomOwnerBinding(malformed)).toBeNull();
    }
  });
  it('allows only the additive owner field for an exact retained legacy initialization', () => {
    const saved = {editorCapHash: encoded(32), envelope: {ciphertext: encoded(32)}, expiresAtMs: Date.now() + 1000,
      operationId: encoded(16), publisherKeyId: `sha256:${encoded(32)}`, requestDigest: encoded(32), viewerCapHash: encoded(32)};
    const supplied = {...saved, ownerBinding: owner()}; const prior = JSON.stringify(saved);
    expect(compatibleLegacyRoomInitialization(prior, JSON.stringify(supplied))).toBe(true);
    for (const changed of [{...supplied, envelope: {ciphertext: encoded(32)}}, {...supplied, viewerCapHash: encoded(32)},
      {...supplied, expiresAtMs: saved.expiresAtMs + 1}, {...supplied, operationId: encoded(16)},
      {...supplied, requestDigest: encoded(32)}, {...supplied, extra: true}, {...supplied, ownerBinding: null}, saved]) {
      expect(compatibleLegacyRoomInitialization(prior, JSON.stringify(changed))).toBe(false);
    }
    expect(compatibleLegacyRoomInitialization(JSON.stringify(supplied), JSON.stringify(supplied))).toBe(false);
    expect(compatibleLegacyRoomInitialization('x'.repeat(724_993), JSON.stringify(supplied))).toBe(false);
    expect(compatibleLegacyRoomInitialization('{"operationId":0,"operationId":1}', JSON.stringify(supplied))).toBe(false);
  });
});
