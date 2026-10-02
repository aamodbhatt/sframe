import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';

const load = async (artifact: string) => {
  const verifier = await import(pathToFileURL(resolve(`${artifact}.js`)).href);
  verifier.initSync({module: await readFile(`${artifact}_bg.wasm`)});
  return verifier as {wasm_verifier_self_test(): boolean; wasm_verify_package(bytes: Uint8Array, digest: string, publisher: string): string};
};

describe('narrow server adapter agrees with the browser shared core', () => {
  it('preserves golden results and failures across archive mutations and canonical pins', async () => {
    const browser = await load('target/phase1-wasm/smallframe_verifier');
    const server = await load('target/server-verifier-wasm/smallframe_server_verifier');
    expect(browser.wasm_verifier_self_test()).toBe(true);
    expect(server.wasm_verifier_self_test()).toBe(true);
    for (const filename of ['canonical-package-v1', 'phase2-decision-board-v1']) {
      const archive = new Uint8Array(Buffer.from((await readFile(`packages/protocol/vectors/${filename}.zip.b64`, 'utf8')).trim(), 'base64'));
      const accepted = JSON.parse(browser.wasm_verify_package(archive, '', '')) as {ok: boolean; packageDigest: string; publisherKeyId: string};
      expect(accepted.ok).toBe(true);
      const changed = new Uint8Array(archive); changed[60] ^= 1;
      const variants = [archive, changed, archive.slice(0, -1), new Uint8Array([...archive, 0])];
      for (const bytes of variants) {
        for (const [digest, publisher] of [['', ''], [accepted.packageDigest, accepted.publisherKeyId],
          [`${accepted.packageDigest}=`, accepted.publisherKeyId], ['short', accepted.publisherKeyId],
          [accepted.packageDigest, 'sha256:wrong']]) {
          const actual = JSON.parse(server.wasm_verify_package(bytes, digest!, publisher!));
          expect(actual).toEqual(JSON.parse(browser.wasm_verify_package(bytes, digest!, publisher!)));
        }
      }
    }
  });
});
