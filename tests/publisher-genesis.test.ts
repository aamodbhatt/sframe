import {randomBytes} from 'node:crypto';
import {verifyAsync} from '@noble/ed25519';
import {describe, expect, it} from 'vitest';
import {encryptSnapshot, encodeBase64Url} from '../packages/protocol/src/index.js';
import {validSignedGenesis} from '../apps/api/src/publisher-genesis.js';

const fixture = async () => {
  const roomId = randomBytes(16).toString('base64url'); const digest = randomBytes(32).toString('base64url');
  const {envelope} = await encryptSnapshot({roomKey: randomBytes(32), writerPrivateKey: randomBytes(32), roomId,
    appId: 'test.genesis', packageDigest: digest, stateEpoch: 0, proposedRevision: 1,
    previousEnvelopeDigest: encodeBase64Url(new Uint8Array(32)), automergeBytes: randomBytes(32)});
  return {envelope, roomId, digest};
};
describe('signed genesis admission before reserving publisher operations', () => {
  it('rejects extra fields, noncanonical encodings, changed ciphertext and mismatched signed contexts', async () => {
    const {envelope, roomId, digest} = await fixture();
    const verify = (value: unknown) => validSignedGenesis(value, roomId, digest, envelope.writerPublicKey);
    expect(await verify(envelope)).toBe(true);
    for (const bad of [{...envelope, unexpected: true}, {...envelope, envelopeSalt: `${envelope.envelopeSalt}=`},
      {...envelope, ciphertext: randomBytes(32).toString('base64url')},
      {...envelope, aad: {...envelope.aad, proposedRevision: 2}},
      {...envelope, aad: {...envelope.aad, unexpected: true}},
      {...envelope, previousEnvelopeDigest: randomBytes(32).toString('base64url')},
      {...envelope, writerSignature: randomBytes(64).toString('base64url')}]) expect(await verify(bad)).toBe(false);
    expect(await validSignedGenesis(envelope, randomBytes(16).toString('base64url'), digest, envelope.writerPublicKey)).toBe(false);
  });
  it('rejects an identity-point forgery that the cofactored JS signature equation accepts', async () => {
    const {envelope, roomId, digest} = await fixture();
    const identity = new Uint8Array(32); identity[0] = 1;
    const signature = new Uint8Array(64); signature[0] = 1;
    expect(await verifyAsync(signature, randomBytes(32), identity)).toBe(true);
    const writer = encodeBase64Url(identity);
    expect(await validSignedGenesis({...envelope, writerPublicKey: writer,
      writerSignature: encodeBase64Url(signature)}, roomId, digest, writer)).toBe(false);
  });
});
