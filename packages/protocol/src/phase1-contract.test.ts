import Ajv2020 from 'ajv/dist/2020.js';
import {verifyAsync} from '@noble/ed25519';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {canonicalJson, parseVerifierResult} from './index.js';

const schemas = join(process.cwd(), 'packages', 'protocol', 'schemas');

describe('Phase 1 language-neutral protocol', () => {
  it('compiles every checked-in schema under strict Draft 2020-12', () => {
    const ajv = new Ajv2020({strict: true, allErrors: true});
    const documents = readdirSync(schemas).filter((value) => value.endsWith('.json')).sort()
      .map((filename) => ({filename, schema: JSON.parse(readFileSync(join(schemas, filename), 'utf8')) as object & {$id?: string}}));
    expect(() => ajv.addSchema(documents.map(({schema}) => schema))).not.toThrow();
    for (const {filename, schema} of documents) expect(ajv.getSchema(schema.$id ?? '') !== undefined, filename).toBe(true);
  });

  it('accepts only the exact native/Wasm verifier boundary', () => {
    const valid = parseVerifierResult('{"ok":true,"packageDigest":"xGzOKkefgzfEFU-AFvSM4zHn9bw-XF3xwlHoz-QHJAA","artifactDigest":"O0lEC4tH1tN_ncCX_FalC8uNSyxOpSRvFUU59BLbr5E","publisherKeyId":"sha256:_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk"}');
    expect(valid.ok).toBe(true);
    expect(parseVerifierResult('{"ok":false,"error":{"code":"PACKAGE_DIGEST_MISMATCH"}}')).toEqual({ok: false, error: {code: 'PACKAGE_DIGEST_MISMATCH'}});
    expect(() => parseVerifierResult('{"ok":true,"packageDigest":"x","artifactDigest":"x","publisherKeyId":"x","extra":true}')).toThrow('VERIFIER_RESULT_SCHEMA');
    expect(() => parseVerifierResult('{"ok":false,"error":{"code":"bad-code"}}')).toThrow('VERIFIER_RESULT_SCHEMA');
  });

  it('contains every native stable error code in the language-neutral registry', () => {
    const registry = JSON.parse(readFileSync(join(schemas, 'error-codes-v1.json'), 'utf8')) as {enum: string[]};
    const rust = readFileSync(join(process.cwd(), 'crates', 'smallframe-core', 'src', 'error.rs'), 'utf8');
    const nativeCodes = [...rust.matchAll(/=> "([A-Z][A-Z0-9_]+)"/gu)].map((match) => match[1] as string);
    expect(nativeCodes.length).toBeGreaterThan(20);
    for (const code of nativeCodes) expect(registry.enum, code).toContain(code);
    expect(new Set(registry.enum).size).toBe(registry.enum.length);
  });

  it('agrees with native canonicalization and detached DSSE-PAE signatures', async () => {
    type Vector = {id: string; payloadType: string; record: unknown; canonicalBase64: string; signature: string};
    const set = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'protocol', 'vectors', 'signed-records-v1.json'), 'utf8')) as {vectors: Vector[]};
    const publicKeys: Record<string, string> = {
      roomDescriptor: '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw',
      publisherEnrollment: '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw',
      controllerRelease: 'IBLLkMpg6OXY2vZuInLSIz4EhtVX6MZhQe2JIBd9frc'
    };
    const encoder = new TextEncoder();
    for (const vector of set.vectors) {
      const canonical = encoder.encode(canonicalJson(vector.record));
      expect(Buffer.from(canonical).toString('base64'), vector.id).toBe(vector.canonicalBase64);
      const prefix = encoder.encode(`DSSEv1 ${vector.payloadType.length} ${vector.payloadType} ${canonical.byteLength} `);
      const pae = new Uint8Array(prefix.byteLength + canonical.byteLength);
      pae.set(prefix);
      pae.set(canonical, prefix.byteLength);
      expect(await verifyAsync(Buffer.from(vector.signature, 'base64url'), pae, Buffer.from(publicKeys[vector.id] ?? '', 'base64url')), vector.id).toBe(true);
      const mutated = Uint8Array.from(pae);
      const last = mutated.length - 1;
      mutated[last] = (mutated[last] ?? 0) ^ 1;
      expect(await verifyAsync(Buffer.from(vector.signature, 'base64url'), mutated, Buffer.from(publicKeys[vector.id] ?? '', 'base64url')), vector.id).toBe(false);
    }
  });
});
