import {describe, expect, it} from 'vitest';
import {encodeBase64Url} from '../../../packages/protocol/src/crypto-envelope.js';
import {validateReplicaMetadata, verifiedRelayEtag, MAX_RECORDED_GAPS} from './replica-metadata.js';

// Coordination-only synthetic metadata; no keys, capabilities or room state.
const valid = () => ({stateEpoch: 0, revision: 1, envelopeDigest: 'A'.repeat(43),
  etag: `"sf1.0.1.${'A'.repeat(43)}"`, actorId: '12'.repeat(16), dirty: false,
  updatedAt: 1, automergeBase64: 'AA'});

describe('restored replica metadata', () => {
  it('accepts structurally valid metadata for separate document validation', () => {
    expect(() => validateReplicaMetadata(valid())).not.toThrow();
  });
  const invalid: [string, unknown][] = [
    ['stateEpoch', -1], ['stateEpoch', 17], ['stateEpoch', '0'], ['stateEpoch', 0.5],
    ['revision', 0], ['revision', -1], ['revision', 1.5], ['revision', Number.MAX_SAFE_INTEGER + 1],
    ['envelopeDigest', 'A'.repeat(42)], ['envelopeDigest', 'A'.repeat(42) + 'B'],
    ['etag', '*'], ['etag', `"sf1.0.2.${'A'.repeat(43)}"`],
    ['actorId', ''], ['actorId', 'A'.repeat(32)], ['actorId', 'g'.repeat(32)], ['actorId', '12'.repeat(17)],
    ['dirty', 'false'], ['dirty', 0], ['updatedAt', -1], ['updatedAt', Infinity],
    ['automergeBase64', ''], ['automergeBase64', 'AA=='], ['automergeBase64', 'AB'],
    ['automergeBase64', 'A'.repeat(633_516)]
  ];
  for (const [index, [field, value]] of invalid.entries()) {
    it(`rejects malformed metadata case ${index + 1} (${field})`, () => {
      expect(() => validateReplicaMetadata({...valid(), [field]: value})).toThrow('LOCAL_STATE_INVALID');
    });
  }
  it('checks actual decoded byte bounds at the maximum encoded length', () => {
    const exact = encodeBase64Url(new Uint8Array(475_136));
    expect(() => validateReplicaMetadata({...valid(), automergeBase64: exact})).not.toThrow();
    expect(() => validateReplicaMetadata({...valid(), automergeBase64: encodeBase64Url(new Uint8Array(475_137))})).toThrow('LOCAL_STATE_INVALID');
  });
  it.each([null, [], 0])('rejects a non-record', (value) => {
    expect(() => validateReplicaMetadata(value)).toThrow('LOCAL_STATE_INVALID');
  });
  it('bounds and validates durable gap and direct-edge metadata', () => {
    const tuple = (revision: number) => ({stateEpoch: 0, revision, envelopeDigest: 'A'.repeat(43)});
    const room = {...valid(), revision: 5, etag: `"sf1.0.5.${'A'.repeat(43)}"`};
    const lineage = {version: 1, gaps: [{from: tuple(1), to: tuple(3)}],
      lastVerifiedEdge: {from: tuple(4), to: tuple(5)}, unknownPriorHistory: false};
    expect(() => validateReplicaMetadata({...room, lineage})).not.toThrow();
    for (const malformed of [
      {...lineage, gaps: [{from: tuple(1), to: tuple(2)}]},
      {...lineage, gaps: [{from: tuple(1), to: tuple(6)}]},
      {...lineage, gaps: [{from: tuple(1), to: {...tuple(5), envelopeDigest: 'B'.repeat(43)}}]},
      {...lineage, lastVerifiedEdge: {from: tuple(3), to: tuple(5)}},
      {...lineage, lastVerifiedEdge: {from: tuple(4), to: {...tuple(5), envelopeDigest: 'B'.repeat(43)}}},
      {...lineage, unknownPriorHistory: 'false'},
      {...lineage, gaps: Array.from({length: MAX_RECORDED_GAPS + 1}, () => ({from: tuple(1), to: tuple(3)}))}
    ]) expect(() => validateReplicaMetadata({...room, lineage: malformed})).toThrow('LOCAL_STATE_INVALID');
  });
});

describe('verified relay ETag', () => {
  it('uses the authenticated tuple with a matching or absent header', () => {
    const etag = valid().etag;
    expect(verifiedRelayEtag(etag, etag)).toBe(etag);
    expect(verifiedRelayEtag(null, etag)).toBe(etag);
  });
  it.each(['*', '', 'W/"weak"', '"sf1.0.01.invalid"'])('rejects a mismatched header', (received) => {
    expect(() => verifiedRelayEtag(received, valid().etag)).toThrow('REMOTE_STATE_INVALID');
  });
});
