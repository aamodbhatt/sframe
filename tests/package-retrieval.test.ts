import {createHash, randomBytes} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {handleGetPackage, handlePublisherGetPackage, type PublishStore} from '../apps/api/src/publish-api.js';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64url');
const fixture = () => {
  const store: PublishStore = {invites: new Map(), publishers: new Map(), publishersByKeyId: new Map(),
    packages: new Map(), rooms: new Map(), operations: new Map()};
  const bytes = new Uint8Array(1024).fill(0x42);
  const digest = hash(bytes);
  const token = randomBytes(32);
  const publisher = {publisherKeyId: `sha256:${hash(randomBytes(32))}`, publisherPublicKey: randomBytes(32).toString('base64url'),
    tokenHash: hash(token), enrolledAt: Date.now()};
  store.publishers.set(publisher.tokenHash, publisher);
  store.packages.set(digest, {packageDigest: digest, artifactDigest: digest, publisherKeyId: publisher.publisherKeyId,
    byteLength: bytes.byteLength, bytes, createdAt: Date.now()});
  return {store, bytes, digest, token};
};

describe('package retrieval authority and stored integrity', () => {
  it('serves intact bytes privately and rejects substituted bytes or metadata', async () => {
    const {store, digest, bytes} = fixture();
    const response = await handleGetPackage(digest, store);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await response.arrayBuffer()).byteLength).toBe(1024);
    const record = store.packages.get(digest)!;
    bytes[0] ^= 1;
    expect((await handleGetPackage(digest, store)).status).toBe(409);
    bytes[0] ^= 1;
    record.byteLength += 1;
    expect((await handleGetPackage(digest, store)).status).toBe(409);
    record.byteLength -= 1;
    record.packageDigest = hash(randomBytes(32));
    expect((await handleGetPackage(digest, store)).status).toBe(409);
  });

  it('requires a canonical publisher token and enforces ownership', async () => {
    const {store, digest, token} = fixture();
    const get = (authorization?: string) => handlePublisherGetPackage(new Request('http://api.localhost/package', {
      headers: authorization ? {Authorization: authorization} : {},
    }), digest, store);
    expect((await get(`Bearer ${token.toString('base64url')}`)).status).toBe(200);
    for (const authorization of [undefined, 'Bearer malformed', `Bearer ${token.toString('base64url')}=`,
      `Bearer ${randomBytes(32).toString('base64url')}`]) {
      expect((await get(authorization)).status).toBe(401);
    }
    const otherToken = randomBytes(32);
    store.publishers.set(hash(otherToken), {publisherKeyId: `sha256:${hash(randomBytes(32))}`,
      publisherPublicKey: randomBytes(32).toString('base64url'), tokenHash: hash(otherToken), enrolledAt: Date.now()});
    expect((await get(`Bearer ${otherToken.toString('base64url')}`)).status).toBe(404);
  });
});
