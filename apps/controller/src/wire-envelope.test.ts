import {describe, expect, it} from 'vitest';
import {validateWireEnvelope} from './wire-envelope.js';

// Synthetic public wire fields only; these are not encrypted room contents.
const binary = (bytes: number) => 'A'.repeat(Math.ceil(bytes * 4 / 3));
const valid = () => ({version: 1, stateEpoch: 0, proposedRevision: 1, envelopeSalt: binary(16),
  previousEnvelopeDigest: binary(32), ciphertext: binary(16), writerPublicKey: binary(32), writerSignature: binary(64),
  aad: {protocolVersion: 1, appId: 'test.example', roomId: binary(16), packageDigest: binary(32),
    stateEpoch: 0, proposedRevision: 1, previousEnvelopeDigest: binary(32)}});

describe('strict incoming envelope shape', () => {
  it('accepts the exact field contract before cryptographic validation', () => {
    expect(validateWireEnvelope(valid())).toEqual(valid());
  });
  it.each(['extra', 'missing', 'aad-extra', 'aad-missing', 'array', 'null'])('rejects %s fields/containers', (kind) => {
    const envelope: any = valid();
    if (kind === 'extra') envelope.ignored = true;
    if (kind === 'missing') delete envelope.writerSignature;
    if (kind === 'aad-extra') envelope.aad.ignored = true;
    if (kind === 'aad-missing') delete envelope.aad.protocolVersion;
    expect(() => validateWireEnvelope(kind === 'array' ? [] : kind === 'null' ? null : envelope)).toThrow('REMOTE_STATE_INVALID');
  });
  const invalid: [string, unknown][] = [
    ['version', 2], ['stateEpoch', -1], ['stateEpoch', 17], ['stateEpoch', 0.5],
    ['proposedRevision', 0], ['proposedRevision', '1'], ['proposedRevision', Number.MAX_SAFE_INTEGER + 1],
    ['envelopeSalt', binary(15)], ['envelopeSalt', binary(16) + '='],
    ['previousEnvelopeDigest', binary(31)], ['writerPublicKey', binary(33)],
    ['writerSignature', binary(64).slice(0, -1) + 'B'], ['ciphertext', binary(16).slice(0, -1) + 'B'],
    ['ciphertext', binary(32) + '\n'], ['ciphertext', binary(15)], ['ciphertext', binary(524_289)],
    ['ciphertext', '%41'], ['ciphertext', {}]
  ];
  for (const [index, [field, value]] of invalid.entries()) {
    it(`rejects malformed wire case ${index + 1} (${field})`, () => {
      expect(() => validateWireEnvelope({...valid(), [field]: value})).toThrow('REMOTE_STATE_INVALID');
    });
  }
  it.each(['protocolVersion', 'stateEpoch', 'proposedRevision', 'previousEnvelopeDigest', 'roomId', 'packageDigest', 'appId'])('rejects mismatched or malformed AAD %s', (field) => {
    const envelope = valid();
    const bad: Record<string, unknown> = {protocolVersion: 2, stateEpoch: 1, proposedRevision: 2,
      previousEnvelopeDigest: 'B'.repeat(43), roomId: 'bad', packageDigest: 'bad', appId: ''};
    expect(() => validateWireEnvelope({...envelope, aad: {...envelope.aad, [field]: bad[field]}})).toThrow('REMOTE_STATE_INVALID');
  });
  it('accepts the maximum ciphertext length and recovery epoch bound', () => {
    const envelope = valid();
    envelope.ciphertext = binary(524_288);
    envelope.stateEpoch = 16;
    envelope.aad.stateEpoch = 16;
    expect(() => validateWireEnvelope(envelope)).not.toThrow();
  });
});
