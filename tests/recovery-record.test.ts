import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import canonicalize from 'canonicalize';
import {getPublicKeyAsync, signAsync} from '@noble/ed25519';
import {describe, expect, it} from 'vitest';
import {decodeBase64Url, encodeBase64Url, sha256} from '../packages/protocol/src/crypto-envelope.js';
import {dssePae} from '../packages/protocol/src/room-descriptor.js';
import {MAX_REPAIR_RECORD_BYTES, POISONED_HEAD_PAYLOAD_TYPE, parsePoisonedHeadRepairRecord,
  signPoisonedHeadRepair, verifyPoisonedHeadRepair, type PoisonedHeadRepairRecord} from '../packages/protocol/src/recovery.js';

const vector = JSON.parse(readFileSync(new URL('../packages/protocol/vectors/poisoned-head-repair-v1.json', import.meta.url), 'utf8')) as {
  record: PoisonedHeadRepairRecord; jcsBase64Url: string; paeSha256: string; publisherPublicKey: string; signature: string;
};
const bytes = (record: unknown): Uint8Array => new TextEncoder().encode(canonicalize(record)!);
const mutateEncoding = (value: string): string => {
  const decoded = decodeBase64Url(value);
  decoded[0] = decoded[0]! ^ 1;
  return encodeBase64Url(decoded);
};

describe('bounded exact-head publisher repair records', () => {
  it('matches the public native/TS JCS and DSSE verification vector and rejects mutation of every field', async () => {
    const canonical = decodeBase64Url(vector.jcsBase64Url);
    const publicKey = decodeBase64Url(vector.publisherPublicKey);
    expect(parsePoisonedHeadRepairRecord(canonical)).toEqual(vector.record);
    expect(encodeBase64Url(await sha256(dssePae(POISONED_HEAD_PAYLOAD_TYPE, canonical)))).toBe(vector.paeSha256);
    expect(await verifyPoisonedHeadRepair({record: vector.record, signature: vector.signature}, publicKey)).toBe(true);
    for (const [field, value] of Object.entries(vector.record)) {
      const changed = typeof value === 'number' ? value + 1
        : field === 'reason' ? 'OTHER' : field === 'publisherKeyId' ? `sha256:${mutateEncoding(value.slice(7))}` : mutateEncoding(value);
      expect(await verifyPoisonedHeadRepair({record: {...vector.record, [field]: changed}, signature: vector.signature}, publicKey)).toBe(false);
    }
    for (let index = 0; index < 64; index += 1) {
      const signature = decodeBase64Url(vector.signature);
      signature[index] = signature[index]! ^ 1;
      expect(await verifyPoisonedHeadRepair({record: vector.record, signature: encodeBase64Url(signature)}, publicKey)).toBe(false);
    }
    expect(await verifyPoisonedHeadRepair({record: vector.record, signature: vector.signature + '='}, publicKey)).toBe(false);
    expect(await verifyPoisonedHeadRepair({record: vector.record, signature: vector.signature, payloadType: 'other'}, publicKey)).toBe(false);
  });

  it('rejects duplicate, noncanonical, oversized and unsafe records before verification', () => {
    const canonical = new TextDecoder().decode(decodeBase64Url(vector.jcsBase64Url));
    for (const input of ['{"protocolVersion":1,' + canonical.slice(1), '{"\\u0070rotocolVersion":1,' + canonical.slice(1),
      ' ' + canonical, canonical.replace('"expectedStateEpoch":0', '"expectedStateEpoch":-0')]) {
      expect(() => parsePoisonedHeadRepairRecord(new TextEncoder().encode(input))).toThrow('REPAIR_RECORD_INVALID');
    }
    expect(() => parsePoisonedHeadRepairRecord(new Uint8Array(MAX_REPAIR_RECORD_BYTES + 1))).toThrow('REPAIR_RECORD_INVALID');
    expect(() => parsePoisonedHeadRepairRecord(Uint8Array.of(123, 255, 125))).toThrow('REPAIR_RECORD_INVALID');
    for (const changes of [{expectedStateEpoch: 17}, {expectedRevision: 0}, {expectedRevision: Number.MAX_SAFE_INTEGER + 1},
      {createdAt: -1}, {createdAt: Number.MAX_SAFE_INTEGER + 1}, {reason: 'OTHER'}, {operationId: vector.record.operationId + '='},
      {viewerDescriptorDigest: vector.record.viewerDescriptorDigest.slice(1)}, {unknown: true}]) {
      expect(() => parsePoisonedHeadRepairRecord(bytes({...vector.record, ...changes}))).toThrow('REPAIR_RECORD_INVALID');
    }
    expect(parsePoisonedHeadRepairRecord(bytes({...vector.record, expectedStateEpoch: 16,
      expectedRevision: Number.MAX_SAFE_INTEGER, createdAt: Number.MAX_SAFE_INTEGER})).expectedStateEpoch).toBe(16);
  });

  it('refuses malformed records even with a real signature and binds the signing key ID', async () => {
    const seed = new Uint8Array(randomBytes(32));
    const publicKey = await getPublicKeyAsync(seed);
    const record = {...vector.record, publisherKeyId: `sha256:${encodeBase64Url(await sha256(publicKey))}`};
    const signed = await signPoisonedHeadRepair(record, seed);
    expect(await verifyPoisonedHeadRepair(signed, publicKey)).toBe(true);
    const malformed = {...record, extra: true};
    const realSignature = encodeBase64Url(await signAsync(dssePae(POISONED_HEAD_PAYLOAD_TYPE, bytes(malformed)), seed));
    expect(await verifyPoisonedHeadRepair({record: malformed, signature: realSignature}, publicKey)).toBe(false);
    await expect(signPoisonedHeadRepair(malformed, seed)).rejects.toThrow('REPAIR_RECORD_INVALID');
    await expect(signPoisonedHeadRepair(vector.record, seed)).rejects.toThrow('REPAIR_PUBLISHER_MISMATCH');
    const wrongPayload = encodeBase64Url(await signAsync(dssePae('application/other', bytes(record)), seed));
    expect(await verifyPoisonedHeadRepair({record, signature: wrongPayload}, publicKey)).toBe(false);
    const pending = signPoisonedHeadRepair(record, seed);
    record.expectedRevision += 1;
    const immutable = await pending;
    expect(immutable.record.expectedRevision).toBe(vector.record.expectedRevision);
    expect(await verifyPoisonedHeadRepair(immutable, publicKey)).toBe(true);
    seed.fill(0);
  });
});
