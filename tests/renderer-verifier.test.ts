import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';

type Binding = {initSync(options: {module: Uint8Array}): void; wasm_verifier_version(): number;
  wasm_verifier_self_test(): boolean; wasm_prepare_package(bytes: Uint8Array, digest: string, publisher: string): string;
  wasm_verify_package(bytes: Uint8Array, digest: string, publisher: string): string;
  wasm_validate_state(schema: string, state: string, limit: number): string; wasm_sha256_hex(bytes: Uint8Array): string};
const load = async (path: string) => {
  const binding = await import(pathToFileURL(resolve(`${path}.js`)).href) as Binding;
  binding.initSync({module: await readFile(`${path}_bg.wasm`)}); return binding;
};

describe('renderer-only shared verifier artifact', () => {
  it('agrees with the full binding on preparation, corrupt archives, pins and hostile state schemas', async () => {
    const full = await load('target/phase1-wasm/smallframe_verifier');
    const renderer = await load('target/renderer-verifier-wasm/smallframe_renderer_verifier');
    expect(renderer.wasm_verifier_version()).toBe(1); expect(renderer.wasm_verifier_self_test()).toBe(true);
    expect(Object.keys(renderer).some((key) => key.startsWith('wasm_automerge_'))).toBe(false);
    expect(Object.keys(full).some((key) => key.startsWith('wasm_automerge_'))).toBe(true);
    for (const filename of ['canonical-package-v1', 'phase2-decision-board-v1']) {
      const archive = new Uint8Array(Buffer.from((await readFile(`packages/protocol/vectors/${filename}.zip.b64`, 'utf8')).trim(), 'base64'));
      const accepted = JSON.parse(full.wasm_prepare_package(archive, '', '')) as {ok: boolean; packageDigest: string; publisherKeyId: string};
      expect(accepted.ok).toBe(true);
      const changed = archive.slice(); changed[60] ^= 1;
      for (const bytes of [archive, changed, archive.slice(0, -1), new Uint8Array([...archive, 0])]) {
        for (const [digest, publisher] of [['', ''], [accepted.packageDigest, accepted.publisherKeyId],
          [`${accepted.packageDigest}=`, accepted.publisherKeyId], ['short', accepted.publisherKeyId], [accepted.packageDigest, 'sha256:wrong']]) {
          expect(JSON.parse(renderer.wasm_prepare_package(bytes, digest!, publisher!))).toEqual(JSON.parse(full.wasm_prepare_package(bytes, digest!, publisher!)));
          expect(JSON.parse(renderer.wasm_verify_package(bytes, digest!, publisher!))).toEqual(JSON.parse(full.wasm_verify_package(bytes, digest!, publisher!)));
        }
      }
      expect(renderer.wasm_sha256_hex(archive)).toBe(createHash('sha256').update(archive).digest('hex'));
    }
    const schema = '{"type":"object","properties":{"count":{"type":"integer"}},"required":["count"],"additionalProperties":false}';
    for (const [shape, state, limit] of [[schema, '{"count":1}', 100], [schema, '{"count":"wrong"}', 100],
      [schema, '{"count":1,"extra":2}', 100], [schema, '{"count":1,"count":2}', 100],
      [schema, '{"count":1}', 2], [schema, '{"count":1}', 393217], ['{"type":"object","type":"array"}', '{}', 100],
      ['{"$ref":"https://invalid.example/schema"}', '{}', 100]] as const) {
      expect(JSON.parse(renderer.wasm_validate_state(shape, state, limit))).toEqual(JSON.parse(full.wasm_validate_state(shape, state, limit)));
    }
  });

  it('pins the actual embedded verifier and enforces the decoded renderer release budget', async () => {
    const bytes = await readFile('target/renderer-verifier-wasm/smallframe_renderer_verifier_bg.wasm');
    const directory = 'dist/controller/runtime/renderer'; const filenames = await readdir(directory);
    expect(filenames).toHaveLength(1);
    const html = await readFile(`${directory}/${filenames[0]}`);
    expect(html.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(html.toString()).toContain(bytes.toString('base64'));
    expect(filenames[0]).toBe(`${createHash('sha256').update(html).digest('hex')}.html`);
    const release = JSON.parse(await readFile('dist/controller/release.json', 'utf8')) as {payload: string};
    const record = JSON.parse(Buffer.from(release.payload, 'base64url').toString()) as {verifierDigest: string};
    expect(record.verifierDigest).toBe(createHash('sha256').update(bytes).digest('base64url'));
  });
});
