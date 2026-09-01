import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'vitest';
import canonicalize from 'canonicalize';
import {verifyAsync} from '@noble/ed25519';

const RELEASE_ROOT_KEY_ID = 'sha256:h-5zg31LoCDgdHkLQnZ6NPQ16O9g8tTJ2qdzt8QlGkA';
const RELEASE_ROOT_PUBLIC_KEY = 'IBLLkMpg6OXY2vZuInLSIz4EhtVX6MZhQe2JIBd9frc';
const RELEASE_PAYLOAD_TYPE = 'application/vnd.smallframe.controller-release.v1+json';

const computeBuildId = (recordWithoutBuildId: Record<string, unknown>): string => {
  const prefix = Buffer.from('smallframe/controller-release/v1\0');
  const canonicalWithout = Buffer.from(canonicalize(recordWithoutBuildId) ?? '');
  return createHash('sha256').update(prefix).update(canonicalWithout).digest('base64url');
};

const verifyDsseSignature = async (payloadType: string, payloadBytes: Uint8Array, signatureB64Url: string, publicKeyB64Url: string): Promise<boolean> => {
  const prefix = Buffer.from(`DSSEv1 ${payloadType.length} ${payloadType} ${payloadBytes.byteLength} `);
  const pae = Buffer.concat([prefix, Buffer.from(payloadBytes)]);
  const sig = Buffer.from(signatureB64Url, 'base64url');
  const pub = Buffer.from(publicKeyB64Url, 'base64url');
  return await verifyAsync(sig, pae, pub);
};

describe('Controller release manifest and verification', () => {
  test('generated release.json adheres to schema and verifies against pinned root key', async () => {
    const releasePath = join(process.cwd(), 'dist', 'controller', 'release.json');
    const envelope = JSON.parse(readFileSync(releasePath, 'utf8'));

    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.payloadType).toBe(RELEASE_PAYLOAD_TYPE);
    expect(envelope.signatures).toHaveLength(1);
    expect(envelope.signatures[0].keyId).toBe(RELEASE_ROOT_KEY_ID);

    const payloadBytes = Buffer.from(envelope.payload, 'base64url');
    const isValidSig = await verifyDsseSignature(envelope.payloadType, payloadBytes, envelope.signatures[0].sig, RELEASE_ROOT_PUBLIC_KEY);
    expect(isValidSig).toBe(true);

    const record = envelope.record;
    expect(record.schemaVersion).toBe(1);
    expect(record.protocolMin).toBeLessThanOrEqual(1);
    expect(record.protocolMax).toBeGreaterThanOrEqual(1);
    expect(record.gitCommit).toMatch(/^[0-9a-f]{40}$/);

    const recordWithout = {
      schemaVersion: record.schemaVersion,
      gitCommit: record.gitCommit,
      createdAt: record.createdAt,
      controllerShellDigest: record.controllerShellDigest,
      controllerAssetSetDigest: record.controllerAssetSetDigest,
      serviceWorkerDigest: record.serviceWorkerDigest,
      rendererDigest: record.rendererDigest,
      verifierDigest: record.verifierDigest,
      protocolMin: record.protocolMin,
      protocolMax: record.protocolMax
    };
    const expectedBuildId = computeBuildId(recordWithout);
    expect(record.buildId).toBe(expectedBuildId);

    const computedAssetSetDigest = createHash('sha256').update(Buffer.from(canonicalize(envelope.assetSet) ?? '')).digest('base64url');
    expect(record.controllerAssetSetDigest).toBe(computedAssetSetDigest);
  });

  test('rejects bit-flipped signature or altered record payload', async () => {
    const releasePath = join(process.cwd(), 'dist', 'controller', 'release.json');
    const envelope = JSON.parse(readFileSync(releasePath, 'utf8'));
    const payloadBytes = Buffer.from(envelope.payload, 'base64url');

    // Mutated signature
    const sigBytes = Buffer.from(envelope.signatures[0].sig, 'base64url');
    if (sigBytes.length > 0) sigBytes[0] = (sigBytes[0] ?? 0) ^ 1;
    const badSig = await verifyDsseSignature(envelope.payloadType, payloadBytes, sigBytes.toString('base64url'), RELEASE_ROOT_PUBLIC_KEY);
    expect(badSig).toBe(false);

    // Mutated payload
    const mutatedPayload = Buffer.from(payloadBytes);
    if (mutatedPayload.length > 0) mutatedPayload[0] = (mutatedPayload[0] ?? 0) ^ 1;
    const badPayload = await verifyDsseSignature(envelope.payloadType, mutatedPayload, envelope.signatures[0].sig, RELEASE_ROOT_PUBLIC_KEY);
    expect(badPayload).toBe(false);
  });

  test('matches golden controller release vector in signed-records-v1.json', async () => {
    const vectorsPath = join(process.cwd(), 'packages', 'protocol', 'vectors', 'signed-records-v1.json');
    const vectorsData = JSON.parse(readFileSync(vectorsPath, 'utf8'));
    const controllerVector = vectorsData.vectors.find((v: {id: string}) => v.id === 'controllerRelease');
    expect(controllerVector).toBeDefined();
    if (!controllerVector) return;

    const canonical = Buffer.from(canonicalize(controllerVector.record) ?? '');
    expect(canonical.toString('base64')).toBe(controllerVector.canonicalBase64);

    const valid = await verifyDsseSignature(controllerVector.payloadType, canonical, controllerVector.signature, RELEASE_ROOT_PUBLIC_KEY);
    expect(valid).toBe(true);
  });
});
